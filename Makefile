.PHONY: dev migrate test check

dev:
	bun run src/server.ts

migrate:
	bun run src/migrate.ts

test:
	bun test

check: test
