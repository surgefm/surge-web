#!/usr/bin/env node

/**
 * Database seed script for local development.
 *
 * Scrapes events, stacks, news, and tags from the production API
 * at https://api.langchao.org and inserts them into the local
 * PostgreSQL database. Creates an admin account and a pseudo user
 * (with a random pseudonym) for every unique contributor/owner
 * found in the scraped data.
 *
 * Usage:
 *   docker compose exec backend node /seed.js
 *   # or via Makefile:
 *   make seed
 *   make seed API=https://my-other-api.example.com
 */

const { Client } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = (process.env.API_BASE || 'https://api.langchao.org').replace(/\/+$/, '');
const MAX_EVENT_PAGES = 10; // safety cap; we expect ~7 pages
const PASSWORD = 'surgefm';
const SALT_ROUNDS = 10;

const pgConfig = {
  host: process.env.POSTGRES_HOST || 'postgres',
  port: +(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PWD || 'postgres',
  database: process.env.POSTGRES_DB || 'v2land',
};

const redisConfig = {
  host: process.env.REDIS_HOST || 'redis',
  port: +(process.env.REDIS_PORT || 6379),
  db: +(process.env.REDIS_DB || 0),
};

// Prefixes used by the app
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'surge-'; // RedisService cache prefix
const ACL_PREFIX = 'surge-acl';                            // ACL backend prefix

// ---------------------------------------------------------------------------
// Pseudonym generator
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  'Swift', 'Bright', 'Silent', 'Calm', 'Bold',
  'Clever', 'Daring', 'Eager', 'Fierce', 'Gentle',
  'Humble', 'Keen', 'Lively', 'Merry', 'Noble',
  'Proud', 'Quick', 'Rustic', 'Steady', 'Tender',
  'Vivid', 'Warm', 'Witty', 'Young', 'Zealous',
  'Amber', 'Azure', 'Coral', 'Crimson', 'Golden',
  'Jade', 'Misty', 'Rosy', 'Silver', 'Violet',
  'Starry', 'Frosty', 'Sunny', 'Dusky', 'Mossy',
];

const NOUNS = [
  'Fox', 'Owl', 'Hare', 'Wren', 'Lynx',
  'Deer', 'Wolf', 'Bear', 'Crow', 'Swan',
  'Otter', 'Eagle', 'Finch', 'Crane', 'Raven',
  'Cedar', 'Maple', 'Birch', 'Aspen', 'Sage',
  'Brook', 'Ridge', 'Frost', 'Storm', 'Ember',
  'Pebble', 'Flint', 'Dusk', 'Dawn', 'Moon',
  'Star', 'Cliff', 'Glen', 'Heath', 'Bloom',
];

function generatePseudonyms(count) {
  const used = new Set();
  const result = [];
  // Deterministic shuffle based on index to keep it reproducible
  for (let i = 0; i < count; i++) {
    const adj = ADJECTIVES[i % ADJECTIVES.length];
    const noun = NOUNS[i % NOUNS.length];
    let name = `${adj} ${noun}`;
    // If collision, append a number
    if (used.has(name)) {
      name = `${adj} ${NOUNS[(i + 7) % NOUNS.length]}`;
    }
    if (used.has(name)) {
      name = `${ADJECTIVES[(i + 13) % ADJECTIVES.length]} ${noun}`;
    }
    if (used.has(name)) {
      name = `${adj} ${noun} ${i}`;
    }
    used.add(name);
    result.push(name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: 15000 });
      return data;
    } catch (err) {
      console.warn(`  ⚠ Attempt ${attempt} failed for ${url}: ${err.message}`);
      if (attempt < 3) await sleep(2000 * attempt);
      else throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Scrape production API
// ---------------------------------------------------------------------------

async function scrapeAPI() {
  const events = new Map();    // id → event object
  const stacks = new Map();    // id → stack object
  const news = new Map();      // id → news object
  const tags = new Map();      // id → tag object
  const headerImages = [];     // { eventId, imageUrl, source, sourceUrl, ... }
  const eventStackNews = [];   // { eventId, stackId, newsId }
  const eventTags = [];        // { eventId, tagId }
  const ownerIds = new Set();

  // --- Paginate event list ---------------------------------------------------
  console.log('📡 Scraping event list...');
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const url = `${API_BASE}/event?page=${page}`;
    console.log(`  Page ${page}: ${url}`);
    let response;
    try {
      response = await fetchJSON(url);
    } catch {
      console.log(`  Page ${page} failed – stopping pagination`);
      break;
    }
    // API returns { eventList: [...] }
    const list = Array.isArray(response) ? response : (response && response.eventList) || [];
    if (list.length === 0) {
      console.log(`  Page ${page} empty – done`);
      break;
    }

    for (const evt of list) {
      if (!evt || !evt.id) continue;
      events.set(evt.id, evt);
      if (evt.ownerId) ownerIds.add(evt.ownerId);

      // tags from list response
      if (Array.isArray(evt.tags)) {
        for (const t of evt.tags) {
          if (t && t.id) {
            tags.set(t.id, t);
            eventTags.push({ eventId: evt.id, tagId: t.id });
          }
        }
      }

      // headerImage from list response
      if (evt.headerImage && evt.headerImage.imageUrl) {
        headerImages.push({
          id: evt.headerImage.id,
          eventId: evt.id,
          imageUrl: evt.headerImage.imageUrl,
          source: evt.headerImage.source || '',
          sourceUrl: evt.headerImage.sourceUrl || null,
          createdAt: evt.headerImage.createdAt,
          updatedAt: evt.headerImage.updatedAt,
        });
      }
    }
    await sleep(300);
  }

  // --- Fetch event details for stacks & news --------------------------------
  console.log(`\n📦 Fetching details for ${events.size} events...`);
  let idx = 0;
  for (const [eventId] of events) {
    idx++;
    const url = `${API_BASE}/event/${eventId}`;
    process.stdout.write(`  [${idx}/${events.size}] Event ${eventId}...`);
    let detail;
    try {
      detail = await fetchJSON(url);
    } catch {
      console.log(' SKIP (failed)');
      continue;
    }

    // Stacks
    if (Array.isArray(detail.stacks)) {
      for (const stack of detail.stacks) {
        if (!stack || !stack.id) continue;
        stacks.set(stack.id, { ...stack, eventId });

        // News inside stack
        if (Array.isArray(stack.news)) {
          for (const n of stack.news) {
            if (!n || !n.id) continue;
            news.set(n.id, n);
            eventStackNews.push({ eventId, stackId: stack.id, newsId: n.id });
          }
        }
      }
    }

    // Off-shelf news
    if (Array.isArray(detail.offshelfNews)) {
      for (const n of detail.offshelfNews) {
        if (!n || !n.id) continue;
        news.set(n.id, n);
      }
    }

    // Tags from detail (may have more than list)
    if (Array.isArray(detail.tags)) {
      for (const t of detail.tags) {
        if (t && t.id) {
          tags.set(t.id, t);
          // avoid duplicate eventTag
          if (!eventTags.some((et) => et.eventId === eventId && et.tagId === t.id)) {
            eventTags.push({ eventId, tagId: t.id });
          }
        }
      }
    }

    // headerImage from detail (may not have been in list)
    if (detail.headerImage && detail.headerImage.imageUrl) {
      if (!headerImages.some((h) => h.id === detail.headerImage.id)) {
        headerImages.push({
          id: detail.headerImage.id,
          eventId,
          imageUrl: detail.headerImage.imageUrl,
          source: detail.headerImage.source || '',
          sourceUrl: detail.headerImage.sourceUrl || null,
          createdAt: detail.headerImage.createdAt,
          updatedAt: detail.headerImage.updatedAt,
        });
      }
    }

    console.log(` ✓ (${stacks.size} stacks, ${news.size} news so far)`);
    await sleep(300);
  }

  console.log(`\n📊 Scraped totals:`);
  console.log(`   Events: ${events.size}`);
  console.log(`   Stacks: ${stacks.size}`);
  console.log(`   News:   ${news.size}`);
  console.log(`   Tags:   ${tags.size}`);
  console.log(`   HeaderImages: ${headerImages.length}`);
  console.log(`   EventStackNews: ${eventStackNews.length}`);
  console.log(`   EventTags: ${eventTags.length}`);
  console.log(`   Unique owner IDs: ${[...ownerIds].sort((a, b) => a - b).join(', ')}`);

  return { events, stacks, news, tags, headerImages, eventStackNews, eventTags, ownerIds };
}

// ---------------------------------------------------------------------------
// Phase 2 + 3: Insert into database
// ---------------------------------------------------------------------------

async function seedDatabase(data) {
  const { events, stacks, news, tags, headerImages, eventStackNews, eventTags, ownerIds } = data;
  const pg = new Client(pgConfig);
  await pg.connect();
  console.log('\n🗄️  Connected to PostgreSQL');

  try {
    await pg.query('BEGIN');

    // ------------------------------------------------------------------
    // 2a. Create admin account (ID 1)
    // ------------------------------------------------------------------
    const hashedPw = await bcrypt.hash(PASSWORD, SALT_ROUNDS);
    const now = new Date().toISOString();

    console.log('\n👤 Creating admin account (surge)...');
    await pg.query(
      `INSERT INTO client (id, username, nickname, email, password, role, "emailVerified", settings, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [1, 'surge', 'Surge', 'surge@local', hashedPw, 'admin', true, '{}', now, now]
    );

    // ------------------------------------------------------------------
    // 2b. Create pseudo users with pseudonyms for every unique owner ID
    // ------------------------------------------------------------------
    const sortedOwnerIds = [...ownerIds].sort((a, b) => a - b).filter((id) => id !== 1);
    const pseudonyms = generatePseudonyms(sortedOwnerIds.length);

    console.log(`👥 Creating ${sortedOwnerIds.length} pseudo user(s)...`);
    for (let i = 0; i < sortedOwnerIds.length; i++) {
      const oid = sortedOwnerIds[i];
      const pseudonym = pseudonyms[i];
      const username = pseudonym.toLowerCase().replace(/\s+/g, '');
      const nickname = pseudonym;
      const email = `${username}@local`;
      await pg.query(
        `INSERT INTO client (id, username, nickname, email, password, role, "emailVerified", settings, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [oid, username, nickname, email, hashedPw, 'contributor', true, '{}', now, now]
      );
      console.log(`   ${oid} → ${pseudonym} (@${username})`);
    }

    // Reset client sequence
    const allClientIds = [1, ...sortedOwnerIds];
    const maxClientId = Math.max(...allClientIds);
    await pg.query(`SELECT setval('client_id_seq', $1, true)`, [maxClientId]);
    console.log(`   ✓ client_id_seq reset to ${maxClientId}`);

    // ------------------------------------------------------------------
    // 3a. Tags
    // ------------------------------------------------------------------
    console.log(`\n🏷️  Inserting ${tags.size} tags...`);
    for (const [, t] of tags) {
      await pg.query(
        `INSERT INTO tag (id, name, slug, description, "hierarchyPath", "redirectToId", "parentId", status, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          t.id,
          t.name,
          t.slug || null,
          t.description || null,
          t.hierarchyPath || null,
          t.redirectToId || null,
          t.parentId || null,
          t.status || 'visible',
          t.createdAt || now,
          t.updatedAt || now,
        ]
      );
    }
    if (tags.size > 0) {
      const maxTagId = Math.max(...[...tags.keys()]);
      await pg.query(`SELECT setval('tag_id_seq', $1, true)`, [maxTagId]);
    }

    // ------------------------------------------------------------------
    // 3b. Events (latestAdmittedNewsId = NULL initially)
    // ------------------------------------------------------------------
    console.log(`📰 Inserting ${events.size} events...`);
    for (const [, e] of events) {
      await pg.query(
        `INSERT INTO event (id, name, pinyin, description, status, "needContributor", "ownerId", "parentId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          e.id,
          e.name,
          e.pinyin || null,
          e.description || null,
          e.status || 'pending',
          e.needContributor || false,
          e.ownerId || 1,
          e.parentId || null,
          e.createdAt || now,
          e.updatedAt || now,
        ]
      );
    }
    if (events.size > 0) {
      const maxEventId = Math.max(...[...events.keys()]);
      await pg.query(`SELECT setval('event_id_seq', $1, true)`, [maxEventId]);
    }

    // ------------------------------------------------------------------
    // 3c. Stacks
    // ------------------------------------------------------------------
    console.log(`📚 Inserting ${stacks.size} stacks...`);
    for (const [, s] of stacks) {
      await pg.query(
        `INSERT INTO stack (id, title, description, status, "order", time, "eventId", "stackEventId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          s.id,
          s.title,
          s.description || null,
          s.status || 'pending',
          s.order != null ? s.order : -1,
          s.time || null,
          s.eventId,
          s.stackEventId || null,
          s.createdAt || now,
          s.updatedAt || now,
        ]
      );
    }
    if (stacks.size > 0) {
      const maxStackId = Math.max(...[...stacks.keys()]);
      await pg.query(`SELECT setval('stack_id_seq', $1, true)`, [maxStackId]);
    }

    // ------------------------------------------------------------------
    // 3d. News
    // ------------------------------------------------------------------
    console.log(`📄 Inserting ${news.size} news...`);
    for (const [, n] of news) {
      await pg.query(
        `INSERT INTO news (id, url, source, title, abstract, time, status, comment, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [
          n.id,
          n.url,
          n.source || '',
          n.title || '',
          n.abstract || null,
          n.time || now,
          n.status || 'pending',
          n.comment || null,
          n.createdAt || now,
          n.updatedAt || now,
        ]
      );
    }
    if (news.size > 0) {
      const maxNewsId = Math.max(...[...news.keys()]);
      await pg.query(`SELECT setval('news_id_seq', $1, true)`, [maxNewsId]);
    }

    // ------------------------------------------------------------------
    // 3e. EventStackNews (join table)
    // ------------------------------------------------------------------
    // Drop bogus UNIQUE constraint on eventId alone (Sequelize model bug).
    // The table already has a composite PK on (eventId, newsId).
    await pg.query(`
      ALTER TABLE "eventStackNews"
        DROP CONSTRAINT IF EXISTS "eventStackNews_eventId_key"
    `);
    console.log(`🔗 Inserting ${eventStackNews.length} event-stack-news links...`);
    for (const esn of eventStackNews) {
      await pg.query(
        `INSERT INTO "eventStackNews" ("eventId", "stackId", "newsId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [esn.eventId, esn.stackId, esn.newsId, now, now]
      );
    }

    // ------------------------------------------------------------------
    // 3f. EventTag (join table)
    // ------------------------------------------------------------------
    console.log(`🏷️  Inserting ${eventTags.length} event-tag links...`);
    for (const et of eventTags) {
      await pg.query(
        `INSERT INTO "eventTag" ("eventId", "tagId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [et.eventId, et.tagId, now, now]
      );
    }

    // ------------------------------------------------------------------
    // 3g. HeaderImages
    // ------------------------------------------------------------------
    console.log(`🖼️  Inserting ${headerImages.length} header images...`);
    for (const h of headerImages) {
      await pg.query(
        `INSERT INTO "headerImage" (id, "imageUrl", source, "sourceUrl", "eventId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          h.id,
          h.imageUrl,
          h.source,
          h.sourceUrl,
          h.eventId,
          h.createdAt || now,
          h.updatedAt || now,
        ]
      );
    }
    if (headerImages.length > 0) {
      const maxHiId = Math.max(...headerImages.map((h) => h.id).filter(Boolean));
      if (maxHiId) {
        await pg.query(`SELECT setval('"headerImage_id_seq"', $1, true)`, [maxHiId]);
      }
    }

    // ------------------------------------------------------------------
    // 3h. Update events with latestAdmittedNewsId (only if the news exists)
    // ------------------------------------------------------------------
    console.log(`🔄 Updating latestAdmittedNewsId for events...`);
    let updatedCount = 0;
    let skippedCount = 0;
    for (const [, e] of events) {
      if (e.latestAdmittedNewsId) {
        if (news.has(e.latestAdmittedNewsId)) {
          await pg.query(
            `UPDATE event SET "latestAdmittedNewsId" = $1 WHERE id = $2`,
            [e.latestAdmittedNewsId, e.id]
          );
          updatedCount++;
        } else {
          skippedCount++;
        }
      }
    }
    console.log(`   ✓ Updated ${updatedCount}, skipped ${skippedCount} (news not in scraped data)`);

    // ------------------------------------------------------------------
    // 3i. Create commit records (required for event list API)
    // ------------------------------------------------------------------
    console.log(`📝 Creating commit records for ${events.size} events...`);
    let commitId = 1;
    for (const [eventId, e] of events) {
      // Build the data snapshot the API expects
      const eventStacks = [...stacks.values()]
        .filter((s) => s.eventId === eventId)
        .sort((a, b) => (a.order ?? -1) - (b.order ?? -1))
        .map((s) => {
          const stackNews = eventStackNews
            .filter((esn) => esn.eventId === eventId && esn.stackId === s.id)
            .map((esn) => news.get(esn.newsId))
            .filter(Boolean)
            .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
          return { ...s, news: stackNews };
        });

      const eventTagsList = eventTags
        .filter((et) => et.eventId === eventId)
        .map((et) => tags.get(et.tagId))
        .filter(Boolean);

      const hi = headerImages.find((h) => h.eventId === eventId) || null;

      const latestNews = e.latestAdmittedNewsId && news.has(e.latestAdmittedNewsId)
        ? news.get(e.latestAdmittedNewsId)
        : null;

      // Determine a timestamp for sorting: first stack time, first news time, or event updatedAt
      let commitTime = null;
      if (eventStacks.length > 0 && eventStacks[0].time) {
        commitTime = eventStacks[0].time;
      } else if (eventStacks.length > 0 && eventStacks[0].news && eventStacks[0].news.length > 0 && eventStacks[0].news[0].time) {
        commitTime = eventStacks[0].news[0].time;
      } else if (latestNews && latestNews.time) {
        commitTime = latestNews.time;
      } else {
        commitTime = e.updatedAt || now;
      }

      // Compute stack-level newsCount and event-level totals
      let totalNewsCount = 0;
      for (const st of eventStacks) {
        st.newsCount = (st.news || []).length;
        totalNewsCount += st.newsCount;
      }

      // Build owner object (matches what EventService.findEvent includes)
      const ownerId = e.ownerId || 1;
      let ownerObj = null;
      if (ownerId === 1) {
        ownerObj = { id: 1, username: 'surge', nickname: 'Surge', avatar: null, description: null };
      } else {
        const idx = sortedOwnerIds.indexOf(ownerId);
        if (idx >= 0) {
          const pn = pseudonyms[idx];
          const un = pn.toLowerCase().replace(/\s+/g, '');
          ownerObj = { id: ownerId, username: un, nickname: pn, avatar: null, description: null };
        }
      }

      const commitData = {
        id: eventId,
        name: e.name,
        pinyin: e.pinyin || null,
        description: e.description || null,
        status: e.status || 'admitted',
        needContributor: e.needContributor || false,
        ownerId,
        parentId: e.parentId || null,
        latestAdmittedNewsId: (latestNews ? latestNews.id : null),
        headerImage: hi ? { id: hi.id, imageUrl: hi.imageUrl, source: hi.source, sourceUrl: hi.sourceUrl, eventId } : null,
        latestAdmittedNews: latestNews,
        stacks: eventStacks,
        tags: eventTagsList,
        offshelfNews: [],
        owner: ownerObj,
        stackCount: eventStacks.length,
        newsCount: totalNewsCount,
        contribution: [],
        contributors: [],
        commitTime: commitTime,
        createdAt: e.createdAt || now,
        updatedAt: e.updatedAt || now,
      };

      // Extract time-of-day from commitTime for the TIME column
      const commitTimeStr = new Date(commitTime).toISOString().split('T')[1].replace('Z', '');

      await pg.query(
        `INSERT INTO commit (id, summary, data, "isForkCommit", time, "authorId", "eventId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          commitId,
          'Seed commit',
          JSON.stringify(commitData),
          false,
          commitTimeStr,
          e.ownerId || 1,
          eventId,
          e.createdAt || now,
          e.updatedAt || now,
        ]
      );
      commitId++;
    }
    await pg.query(`SELECT setval('commit_id_seq', $1, true)`, [commitId - 1]);
    console.log(`   ✓ Created ${commitId - 1} commits`);

    await pg.query('COMMIT');
    console.log('\n✅ Seed complete!');
  } catch (err) {
    await pg.query('ROLLBACK');
    console.error('\n❌ Seed failed — rolled back');
    throw err;
  } finally {
    await pg.end();
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Seed Redis (ACL roles, caches)
// ---------------------------------------------------------------------------

async function seedRedis(data) {
  const { events, ownerIds } = data;
  const rd = new Redis(redisConfig);
  const pg = new Client(pgConfig);
  await pg.connect();
  console.log('\n🔴 Connected to Redis + PostgreSQL for ACL seeding');

  try {
    const sortedOwnerIds = [...ownerIds].sort((a, b) => a - b).filter((id) => id !== 1);
    const allUserIds = [1, ...sortedOwnerIds];
    const pseudonyms = generatePseudonyms(sortedOwnerIds.length);
    const now = new Date().toISOString();

    // ------------------------------------------------------------------
    // 4a. ACL role assignments
    //     The dual-write backend stores in both Redis and Postgres:
    //       Redis:    SADD surge-acl_users@{userId} <roles...>
    //       Postgres: acl_users (key=userId, value=JSON array of roles)
    //       Redis:    SADD surge-acl_roles@{role} <userIds...>
    //       Postgres: acl_roles (key=role, value=JSON array of userIds)
    // ------------------------------------------------------------------
    console.log('\n🔑 Setting ACL role assignments...');

    // Build user→roles and role→users maps
    const userRolesMap = new Map(); // userId → Set of role strings
    const roleUsersMap = new Map(); // roleName → Set of userId strings

    // Admin: surge (id=1) → admins role
    if (!userRolesMap.has(1)) userRolesMap.set(1, new Set());
    userRolesMap.get(1).add('admins');
    if (!roleUsersMap.has('admins')) roleUsersMap.set('admins', new Set());
    roleUsersMap.get('admins').add('1');
    console.log('   1 (surge) → admins');

    // Contributors
    for (const oid of sortedOwnerIds) {
      if (!userRolesMap.has(oid)) userRolesMap.set(oid, new Set());
      userRolesMap.get(oid).add('contributors');
      if (!roleUsersMap.has('contributors')) roleUsersMap.set('contributors', new Set());
      roleUsersMap.get('contributors').add(String(oid));
    }
    console.log(`   ${sortedOwnerIds.length} pseudo users → contributors`);

    // ------------------------------------------------------------------
    // 4b. ACL role-edit-self permissions
    //     Mimics allowClientToEditRole(clientId, clientId):
    //       allow('role-{id}-edit-role', 'role-{id}', ['edit'])
    //       addUserRoles(clientId, 'role-{id}-edit-role')
    // ------------------------------------------------------------------
    console.log('🔐 Setting role-edit-self permissions...');
    for (const uid of allUserIds) {
      const editRole = `role-${uid}-edit-role`;
      const resource = `role-${uid}`;

      // allow(editRole, resource, ['edit']) → Redis + PG permissions
      await rd.sadd(`${ACL_PREFIX}_allows_${editRole}@${resource}`, 'edit');

      // addUserRoles(uid, editRole) → add to maps
      if (!userRolesMap.has(uid)) userRolesMap.set(uid, new Set());
      userRolesMap.get(uid).add(editRole);
      if (!roleUsersMap.has(editRole)) roleUsersMap.set(editRole, new Set());
      roleUsersMap.get(editRole).add(String(uid));
    }
    console.log(`   ✓ ${allUserIds.length} users`);

    // ------------------------------------------------------------------
    // 4b-extra. Event-owner ACL roles
    //     For each event, assign the owner the event-owner-role so they
    //     can edit/manage the event. This mimics setClientEventOwner().
    //
    //     Roles created per event:
    //       event-{id}-view-role   → allow(role, event-{id}, 'view')
    //       event-{id}-edit-role   → allow(role, event-{id}, ['edit','makeCommit'])
    //                                addRoleParents(edit-role, view-role)
    //       event-{id}-manage-role → allow(role, event-{id}, ['addViewer','removeViewer','addEditor','removeEditor'])
    //                                addRoleParents(manage-role, edit-role)
    //       event-{id}-owner-role  → addRoleParents(owner-role, manage-role)
    //     Then: addUserRoles(ownerId, owner-role)
    // ------------------------------------------------------------------
    console.log('📋 Setting event-owner ACL roles...');
    for (const [eventId, e] of events) {
      const ownerId = e.ownerId || 1;
      const viewRole = `event-${eventId}-view-role`;
      const editRole = `event-${eventId}-edit-role`;
      const manageRole = `event-${eventId}-manage-role`;
      const ownerRole = `event-${eventId}-owner-role`;
      const resource = `event-${eventId}`;

      // allow(viewRole, resource, 'view')
      await rd.sadd(`${ACL_PREFIX}_allows_${viewRole}@${resource}`, 'view');
      // allow(editRole, resource, ['edit', 'makeCommit'])
      await rd.sadd(`${ACL_PREFIX}_allows_${editRole}@${resource}`, 'edit', 'makeCommit');
      // addRoleParents(editRole, viewRole)
      await rd.sadd(`${ACL_PREFIX}_parents@${editRole}`, viewRole);
      // allow(manageRole, resource, ['addViewer', 'removeViewer', 'addEditor', 'removeEditor'])
      await rd.sadd(`${ACL_PREFIX}_allows_${manageRole}@${resource}`, 'addViewer', 'removeViewer', 'addEditor', 'removeEditor');
      // addRoleParents(manageRole, editRole)
      await rd.sadd(`${ACL_PREFIX}_parents@${manageRole}`, editRole);
      // addRoleParents(ownerRole, manageRole)
      await rd.sadd(`${ACL_PREFIX}_parents@${ownerRole}`, manageRole);

      // addUserRoles(ownerId, ownerRole)
      if (!userRolesMap.has(ownerId)) userRolesMap.set(ownerId, new Set());
      userRolesMap.get(ownerId).add(ownerRole);
      if (!roleUsersMap.has(ownerRole)) roleUsersMap.set(ownerRole, new Set());
      roleUsersMap.get(ownerRole).add(String(ownerId));
    }
    console.log(`   ✓ ${events.size} events`);

    // ------------------------------------------------------------------
    // Write user→roles to Redis and Postgres
    // ------------------------------------------------------------------
    console.log('💾 Writing ACL user↔role mappings to Redis + Postgres...');
    for (const [uid, roles] of userRolesMap) {
      const rolesArr = [...roles];
      // Redis
      await rd.sadd(`${ACL_PREFIX}_users@${uid}`, ...rolesArr);
      // Postgres acl_users
      await pg.query(
        `INSERT INTO acl_users (key, value, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = $2, "updatedAt" = $4`,
        [uid, JSON.stringify(rolesArr), now, now]
      );
    }
    for (const [role, uids] of roleUsersMap) {
      const uidsArr = [...uids];
      // Redis
      await rd.sadd(`${ACL_PREFIX}_roles@${role}`, ...uidsArr);
      // Postgres acl_roles
      await pg.query(
        `INSERT INTO acl_roles (key, value, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = $2, "updatedAt" = $4`,
        [role, JSON.stringify(uidsArr), now, now]
      );
    }
    console.log(`   ✓ ${userRolesMap.size} users, ${roleUsersMap.size} roles`);

    // ------------------------------------------------------------------
    // 4c. Client name lookup cache
    //     Key: surge-client-name-mem-{username} → JSON stringified ID
    // ------------------------------------------------------------------
    console.log('👤 Populating client name cache...');
    await rd.set(`${REDIS_PREFIX}client-name-mem-surge`, JSON.stringify(1));
    for (let i = 0; i < sortedOwnerIds.length; i++) {
      const oid = sortedOwnerIds[i];
      const username = pseudonyms[i].toLowerCase().replace(/\s+/g, '');
      await rd.set(`${REDIS_PREFIX}client-name-mem-${username}`, JSON.stringify(oid));
    }
    console.log(`   ✓ ${allUserIds.length} entries`);

    // ------------------------------------------------------------------
    // 4d. Event name lookup cache
    //     Key: surge-event-name-mem-{eventname}@{ownerid} → JSON ID
    // ------------------------------------------------------------------
    console.log('📰 Populating event name cache...');
    for (const [eventId, e] of events) {
      const key = `${REDIS_PREFIX}event-name-mem-${e.name}@${e.ownerId || 1}`;
      await rd.set(key, JSON.stringify(eventId));
    }
    console.log(`   ✓ ${events.size} entries`);

    // ------------------------------------------------------------------
    // 4e. Star count cache (initialise to 0)
    //     Key: surge-event-star-count-mem-{eventId} → "0"
    // ------------------------------------------------------------------
    console.log('⭐ Initialising star count cache...');
    for (const [eventId] of events) {
      await rd.set(`${REDIS_PREFIX}event-star-count-mem-${eventId}`, '0');
    }
    console.log(`   ✓ ${events.size} entries`);

    console.log('\n✅ Redis + ACL seed complete!');
  } finally {
    rd.disconnect();
    await pg.end();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    const data = await scrapeAPI();
    await seedDatabase(data);
    await seedRedis(data);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
