# Surge.fm

Monorepo for the Surge.fm platform, orchestrating the frontend and backend as Git submodules with Docker Compose.

## Submodules

- **v2land-frontend** — Next.js frontend ([surgefm/v2land-frontend](https://github.com/surgefm/v2land-frontend))
- **v2land-redstone** — Node.js backend API ([surgefm/v2land-redstone](https://github.com/surgefm/v2land-redstone))

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Git

## Getting Started

```bash
# Clone with submodules
git clone --recurse-submodules git@github.com:surgefm/surge-web.git
cd surge-web

# Start all services (Postgres, Redis, backend, frontend)
./run.sh dev
```

The frontend will be available at `http://localhost:3000` and the backend API at `http://localhost:1337`.

## Seed Data

To populate the local database with data from the production API:

```bash
./run.sh seed
```

You can also specify an alternate API source:

```bash
./run.sh seed https://my-other-api.example.com
```

The seed script creates an admin account (`surge` / `surgefm`) and pseudo users for all contributors found in the scraped data.

## Commands

| Command | Description |
|---------|-------------|
| `./run.sh dev` | Build and start all services |
| `./run.sh down` | Stop all services |
| `./run.sh clean` | Stop all services and remove images (DB data preserved) |
| `./run.sh clean frontend` | Clean only the frontend container and image |
| `./run.sh clean redstone` | Clean only the backend container and image |
| `./run.sh deep-clean` | Stop all services, remove images and all volumes (including DB) |
| `./run.sh logs` | Tail logs from all services |
| `./run.sh shell frontend` | Open a shell in the frontend container |
| `./run.sh shell redstone` | Open a shell in the backend container |
| `./run.sh seed` | Seed the database from the production API |
| `./run.sh seed <url>` | Seed from a custom API source |

## License

[MIT](LICENSE)
