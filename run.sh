#!/usr/bin/env bash
set -euo pipefail

# Map service aliases to docker-compose service names
resolve_service() {
  case "$1" in
    redstone) echo "backend" ;;
    frontend) echo "frontend" ;;
    *) echo "Unknown service: $1. Use 'frontend' or 'redstone'." >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  dev)
    docker compose up --build --force-recreate --renew-anon-volumes
    ;;

  down)
    docker compose down
    ;;

  clean)
    if [[ -n "${2:-}" ]]; then
      svc=$(resolve_service "$2")
      docker compose stop "$svc"
      docker compose rm -f "$svc"
      docker rmi $(docker compose images "$svc" -q) 2>/dev/null || true
    else
      docker compose down --rmi local --remove-orphans
    fi
    docker image prune -f 2>/dev/null || true
    ;;

  deep-clean)
    docker compose down -v --rmi local
    ;;

  logs)
    docker compose logs -f
    ;;

  shell)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 shell <frontend|redstone>" >&2
      exit 1
    fi
    svc=$(resolve_service "$2")
    docker compose exec "$svc" sh
    ;;

  seed)
    docker compose exec -e NODE_PATH=/usr/src/app/node_modules -e API_BASE="${2:-}" backend node /seed.js
    ;;

  *)
    cat <<EOF
Usage: $0 <command> [args]

Commands:
  dev                Build and start all services
  down               Stop all services
  clean              Stop all services and remove images (DB data preserved)
  clean <service>    Clean only one service (frontend or redstone)
  deep-clean         Stop all services, remove images and all volumes (including DB)
  logs               Tail logs from all services
  shell <service>    Open a shell in a container (frontend or redstone)
  seed [api_url]     Seed the database from the production API (or a custom URL)
EOF
    exit 1
    ;;
esac
