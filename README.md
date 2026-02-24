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
make dev
```

The frontend will be available at `http://localhost:3000` and the backend API at `http://localhost:1337`.

## Seed Data

To populate the local database with data from the production API:

```bash
make seed
```

You can also specify an alternate API source:

```bash
make seed API=https://my-other-api.example.com
```

The seed script creates an admin account (`surge` / `surgefm`) and pseudo users for all contributors found in the scraped data.

## Makefile Commands

| Command | Description |
|---------|-------------|
| `make dev` | Build and start all services |
| `make down` | Stop all services |
| `make clean` | Stop all services and remove volumes |
| `make logs` | Tail logs from all services |
| `make backend-shell` | Open a shell in the backend container |
| `make frontend-shell` | Open a shell in the frontend container |
| `make seed` | Seed the database from the production API |

## License

[MIT](LICENSE)
