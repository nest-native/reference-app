# Changelog

All notable changes to this reference app are documented here. Runtime
`dependencies` additions must be justified inline below or in the PR that
added them.

## [Unreleased]

### Added

- All five remaining schema files (`users`, `memberships`, `projects`,
  `audit_events`, `outbox_events`) per brief §5. Foreign keys, the
  `memberships (org_id, user_id)` unique index, the outbox partial unique
  index on `idempotency_key`, and the `(status, available_at)` outbox
  worker-claim index are all expressed in Drizzle and emitted into a new
  drizzle-kit migration `0001_add_core_schema.sql`.
- Seed script populates one org (`acme`), one admin user
  (`admin@acme.test`), the matching admin membership, and one
  `Starter Project`. Idempotent on re-run via SELECT-then-INSERT. Password
  hash uses Node's built-in `scrypt` (no new runtime dep) with format
  `scrypt$<salt-hex>$<hash-hex>` for milestone-4 auth to verify against.
- Integration tests for the five new tables: unique constraints, foreign
  key enforcement, JSON metadata round-trip, outbox partial-unique
  semantics (multiple NULLs allowed, single non-null enforced).
- Seed idempotency test: running seed twice yields stable row IDs.

## [0.0.1-scaffold] - 2026-05-24

Initial bootstrap. Foundation only — no domain modules yet.

### Added

- Repo skeleton: `package.json`, `tsconfig.{base,build,spec}.json`, ESLint
  flat configs (lint + complexity report + complexity gate at 15),
  `drizzle.config.ts`, `.gitignore`, `.nvmrc`.
- Governance files: `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `AI_CODING_GUIDELINES.md`.
- `.github/` layout: PR template, bug/feature issue templates, dependabot
  config, CI workflow on Node 20 + 22 running `npm run ci`.
- Nest scaffold: `main.ts`, `AppModule`, `/health` endpoint.
- `nest-drizzle-native` wired with `better-sqlite3` against an ephemeral
  SQLite file. One schema file (`organizations`) and one drizzle-kit
  migration. A smoke integration test asserts the table is queryable.
- `nest-trpc-native` wired with a single root-level `ping` procedure that
  returns `'pong'`. Generated `AppRouter` schema written to
  `src/@generated/server.ts`.

### Runtime dependency justifications

- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`,
  `reflect-metadata`, `rxjs`: Nest runtime essentials.
- `nest-drizzle-native`, `drizzle-orm`, `better-sqlite3`: the Drizzle layer
  this repo exists to exercise.
- `nest-trpc-native`, `@trpc/server`: the tRPC layer this repo exists to
  exercise.
- `zod`: validation primitive for tRPC procedure schemas; used by the brief
  for the workflow modules in subsequent milestones.
