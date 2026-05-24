# Changelog

All notable changes to this reference app are documented here. Runtime
`dependencies` additions must be justified inline below or in the PR that
added them.

## [Unreleased]

## [0.0.1-scaffold] - 2026-05-24

Initial bootstrap. Foundation only — no domain modules yet.

### Added

- Repo skeleton: `package.json`, `tsconfig.{base,build,spec}.json`, ESLint
  flat configs (lint + complexity report + complexity gate at 15),
  `drizzle.config.ts`, `.gitignore`, `.nvmrc`.
- Governance files: `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`,
  `SECURITY.md`.
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
