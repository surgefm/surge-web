.PHONY: dev down clean logs backend-shell frontend-shell seed

dev:
	docker compose up --build

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f

backend-shell:
	docker compose exec backend sh

frontend-shell:
	docker compose exec frontend sh

seed:
	docker compose exec -e NODE_PATH=/usr/src/app/node_modules -e API_BASE=$(API) backend node /seed.js
