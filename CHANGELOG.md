# Changelog

All notable changes to this reference app are documented here. Runtime
`dependencies` additions must be justified inline below or in the PR that
added them.

## [Unreleased]

### Changed — official better-sqlite3 transaction support

- Bumped `@nestjs-cls/transactional-adapter-drizzle-orm` to `^1.3.0` and
  removed the local `SyncDrizzleTransactionalAdapter` workaround. The
  official adapter now supports synchronous Drizzle drivers via its
  `transactionMode` option (defaults to `'auto'`, detects `better-sqlite3`
  and runs in sync mode) — upstreamed in
  [nestjs-cls#572](https://github.com/Papooch/nestjs-cls/pull/572).
  `AppModule` now wires the official `TransactionalAdapterDrizzleOrm`.

### Added — landing page on nest-native.dev/reference-app

- `docs/index.html` and `docs/styles.css` mirror the org landing site's
  visual language (`nest-native.github.io`). Contents: hero + stack
  panel, eight-milestone status grid, link-out section to the GitHub
  repo / architecture doc / releases / library docs.
- `docs/_config.yml` minimal Jekyll config (no theme, `baseurl:
  /reference-app`, excludes top-level project metadata files from being
  published).
- `docs/architecture.md` in-repo links rewritten to absolute
  `https://github.com/nest-native/reference-app/blob/main/…` URLs so the
  page renders correctly from `nest-native.dev/reference-app/architecture.html`
  as well as from the GitHub blob view.
- Removed `nest-trpc-handover.md`. The `nest-trpc-native` bug it
  described was fixed and shipped in `0.4.3`; the file was archival-only.

### Pages enablement (post-merge, one-time)

GitHub Pages is not yet enabled for this repo. After this PR merges,
enable it from `main:/docs` once so the org-domain auto-route picks
the site up:

```
gh api -X POST repos/nest-native/reference-app/pages \
  -f source[branch]=main -f source[path]=/docs
```

After ~1 minute, `https://nest-native.dev/reference-app/` will resolve.

### Added (milestone 8 — polish)

- `client-smoke/`: a typed tRPC client workspace per brief §5. Imports
  `AppRouter` from `src/@generated/server.ts`, boots the app in-process,
  and exercises one query (`ping`), one mutation (`auth.login`), and one
  auth-protected query (`users.me`) against a live local server using
  `@trpc/client`'s `createTRPCClient` + `httpBatchLink`. Own
  `tsconfig.json` (no workspaces). `npm run client-smoke` runs it;
  `npm run client-smoke:typecheck` is now part of `npm run ci`.
- `Dockerfile`: multi-stage production build. Stage 1 installs full deps
  (including a C++ toolchain so `better-sqlite3`'s prebuild fallback
  succeeds in slim images), generates the tRPC schema, runs `tsc`. Stage
  2 ships `dist/` + production deps + migrations + scripts on a slim
  Node base, with a `/data` volume for SQLite persistence. Default
  command runs the API; override `node dist/scripts/start-worker.js`
  to run the outbox worker off the same image.
- `docker-compose.yml`: two-process stack (api + worker) on a shared
  SQLite volume with an HTTP healthcheck and a 15s `stop_grace_period`
  on the worker. A Postgres service section is committed as a recipe
  (commented) for the production swap path described in
  `docs/architecture.md`.
- `docs/architecture.md`: one-sitting tour — module graph, request
  lifecycle (auth middleware + tRPC + request-scoped DI), the central
  `@Transactional` workflow, why the custom `SyncDrizzleTransactionalAdapter`
  exists, outbox flow, worker process, layout map, test map, production
  deployment recipe.
- README finalized to reflect the v0.1 state across all eight
  milestones; status badge bumped from `bootstrap` to `v0.1`.

### Runtime dependency justifications (milestone 8)

- `@trpc/client`: devDep, consumed only by `client-smoke/`. Not pulled
  into the app's runtime bundle. Required to demonstrate that the
  generated `AppRouter` is consumable by a typed client.

### Added (milestone 7 — outbox worker process)

- `scripts/start-worker.ts`: long-running worker process. Boots a Nest
  application context (no HTTP), resolves `OutboxClaimer` from DI, runs
  `tick()` on an interval (default 2s, configurable via `OUTBOX_POLL_MS`),
  and traps `SIGTERM`/`SIGINT` for graceful shutdown — the in-flight tick
  drains, the Nest container closes, then the process exits cleanly.
  Errors from individual ticks are logged and the loop continues; per-event
  retry/backoff/failure is the claimer's responsibility (from milestone 6).
- The loop body is exported as `runWorkerLoop(claimer, { pollIntervalMs,
  claimer, signal })` so tests can drive it with an `AbortController`
  without spawning a child process.
- `src/config/env.ts` exposes a typed `outbox` block with
  `pollIntervalMs`, `batchSize`, `stuckTimeoutMs`, and `workerInstanceId`
  read from `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE`,
  `OUTBOX_STUCK_TIMEOUT_MS`, and `OUTBOX_WORKER_ID`. Defaults match brief
  §8 (poll 2s, stuck timeout 60s, batch 32).
- `npm run start:worker` script entry point.
- Tests in `test/integration/outbox-worker.spec.ts`:
  - **drain**: a freshly-invited user's `user.invited` outbox row flips to
    `completed`, claimed by the configured worker id, and
    `FakeEmailTransport` records exactly one matching email.
  - **prompt abort**: with a 30s poll interval, an `AbortController.abort()`
    mid-wait returns the loop within 5 seconds (asserted), confirming the
    delay is signal-cancellable.
  - **tick failure resilience**: a synthetic throw from the first
    `claimer.tick()` is logged and the loop keeps polling; on the next
    iteration `tick()` runs normally.

### Added (milestone 6 — audit log + outbox + transactional workflow)

- `nestjs-cls`, `@nestjs-cls/transactional`, and
  `@nestjs-cls/transactional-adapter-drizzle-orm` wired in `AppModule` via
  `ClsModule.forRoot({ plugins: [new ClsPluginTransactional(...)] })`.
- `src/database/sync-drizzle-transactional-adapter.ts`: custom CLS
  transactional adapter that keeps the inner Drizzle callback synchronous.
  Required because the official `@nestjs-cls/transactional-adapter-drizzle-orm`
  wraps the callback in `async`, which silently breaks `better-sqlite3`
  (its `client.transaction(fn)` is synchronous and sees the async callback
  return a Promise immediately, committing an empty tx). The custom
  adapter still returns a Promise from `wrapWithTransaction` to satisfy
  the plugin contract.
- `src/modules/memberships/`: `MembershipsRepository` (single-table repo
  used by the onboarding workflow; uses `@InjectTransaction()` so writes
  participate in the active `@Transactional()` scope).
- `src/modules/audit-log/`: `AuditLogService.record()` — inserts an
  `audit_events` row inside the active tx, via `@InjectTransaction()`.
- `src/modules/outbox/`:
  - `OutboxProducer.enqueue()` writes a pending `outbox_events` row inside
    the active tx.
  - `OutboxRegistry` is a per-topic handler registry (`register(topic, fn)`).
  - `FakeEmailTransport` records `send()` calls for assertable tests.
  - `UserInvitedHandler` registers a handler for the `user.invited` topic
    on module init and dispatches to `FakeEmailTransport`.
  - `OutboxClaimer.tick()` atomically claims pending events (or stuck
    `processing` events past a stuck-timeout — `BEGIN IMMEDIATE` shape per
    brief §8), dispatches to the registered handler, marks `completed`
    on success, retries with exponential backoff + jitter on failure, and
    marks `failed` when `attempts >= maxAttempts`.
- `src/modules/onboarding/`: `OrganizationOnboardingService.inviteUser()` —
  the central `@Transactional()` workflow described in brief §7. Inside
  one transaction: upserts a user (with scrypt hash), inserts the
  membership, inserts a starter project, records a `user.invited` audit
  event, and enqueues a `user.invited` outbox event with an idempotency
  key of the form `user.invited:{orgId}:{userId}:{projectId}`.
- `users.invite` tRPC mutation (`@UseGuards(AuthGuard)`) calls the
  onboarding service; reads `currentOrganization` from the auth context.
- **Three §7 mandatory tests in
  `test/integration/invite-user.workflow.spec.ts`** — all pass on local CI:
  - **Happy path**: invite persists 5 rows (`users`, `memberships`,
    `projects`, `audit_events`, `outbox_events`); a subsequent
    `OutboxClaimer.tick()` marks the row `completed` and records exactly
    one email through `FakeEmailTransport`.
  - **Rollback safety**: forces a `throw` from `ProjectsRepository.create`
    between steps 3 and 4; asserts no rows of any kind from this
    transaction persist and no email is recorded.
  - **Worker crash recovery**: inserts an outbox row directly with
    `status='processing'`, stale `claimed_at`, and a dead `claimed_by`;
    asserts the next `tick()` re-claims (under the configurable
    stuck-timeout), processes exactly once, and an immediate follow-up
    tick is a no-op.

### Runtime dependency justifications (milestone 6)

- `nestjs-cls`: ALS-backed request-scoped state used by
  `@nestjs-cls/transactional`'s `TransactionHost`. Brief §4 lists it.
- `@nestjs-cls/transactional`: the `@Transactional()` decorator used by
  the central workflow. Brief §4 lists it.
- `@nestjs-cls/transactional-adapter-drizzle-orm`: kept as a dep because
  brief §4 lists it, even though this app uses a local sync adapter
  for `better-sqlite3` (see above). Future apps that switch to libsql or
  postgres can drop the custom adapter and use the official one.

### Added (milestone 5 — core modules)

- `src/modules/organizations/` (repository, service, router, module):
  `organizations.current` and `organizations.list` queries. List joins
  through `memberships` to return only orgs the current user belongs to;
  current reads from the request-scoped `CURRENT_ORGANIZATION` provider.
- `src/modules/users/` (repository, service, router, module): `users.me`
  query and `users.list` (returns members of the current org with their
  role and join date).
- `src/modules/projects/` (repository, service, router, module):
  `projects.list`, `projects.get`, and `projects.create` — all scoped to
  the current organization; `create` records the current user as
  `created_by`. `get` returns 404 (`NotFoundException`) for ids outside
  the current org (no cross-tenant lookup leak).
- All three feature modules use `DrizzleModule.forFeature([Repo])` per
  the `nest-drizzle-native` primary API, and gate every procedure with
  `@UseGuards(AuthGuard)` at the class level.
- Tests: 10 e2e procedures cover the read paths, the create+list+get
  round-trip, the 404 path, and 401 on unauthenticated calls. The
  request-scoped `CURRENT_USER`/`CURRENT_ORGANIZATION` providers from
  milestone 4 are exercised end-to-end.

### Added (milestone 4 — auth + request context)

- `src/auth/` module: JWT helpers (`signJwt`/`verifyJwt` using `node:crypto`
  HMAC-SHA256, real 3-part JWT format), scrypt password hash/verify
  (`hashPassword`/`verifyPassword`), `AuthService.login()` (verify password +
  mint JWT, picks first membership as active org), `AuthService.resolve()`
  (verify JWT + parse to `AuthContext`).
- `AuthMiddleware` (Express): extracts Bearer token from `Authorization`,
  populates `req.authContext` on success, silently passes on missing/invalid
  token (`AuthGuard` rejects later).
- `AuthGuard` (Nest): works for both HTTP and tRPC procedures
  (`switchToHttp` and `getArgs()[1]` fall-throughs).
- `AuthRouter` tRPC procedures: `auth.login` mutation and `auth.me` query
  (`@UseGuards(AuthGuard)`).
- `RequestContextModule` exposes request-scoped `CURRENT_USER` and
  `CURRENT_ORGANIZATION` providers for any HTTP-path service that needs them
  via DI (milestone 5+).
- HTTP-only `@CurrentUser`/`@CurrentOrganization` param decorators for use
  in REST controllers; tRPC procedures use `@TrpcContext('authContext')`.
- `src/config/env.ts` now reads `AUTH_SECRET` (min 32 chars; required in
  production; deterministic insecure default in dev/test) and
  `AUTH_TTL_SECONDS` (default 3600).
- Seed refactored to import `hashPassword` from `src/auth/password.ts` — no
  duplication of the scrypt format.
- Tests: 6 JWT tests (roundtrip, tamper, expiry, wrong secret, malformed,
  unsupported alg), 5 password tests (positive, negative, malformed, salt
  uniqueness), 5 e2e auth-flow tests (login, wrong password → 401, me
  without token → 401, me with token, me with bad token → 401).

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
