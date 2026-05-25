---
layout: default
title: Architecture
description: One-sitting tour of the nest-native reference app — module graph, request lifecycle, the central @Transactional workflow, the outbox, and the worker.
---

# Architecture

This is a single-process Nest application (plus one optional sidecar
worker process). It exists to demonstrate how
[`nest-drizzle-native`](https://github.com/nest-native/nest-drizzle-native)
and
[`nest-trpc-native`](https://github.com/nest-native/nest-trpc-native)
compose under realistic backend pressure: feature modules, multi-tenant
context, cross-service transactions, post-commit side effects via a
transactional outbox, and a typed tRPC client.

This document is meant to be read top-to-bottom in one focused sitting.
Each section answers one question.

## Module graph

```
              ┌─────────────────────────────────────────────────┐
              │ AppModule                                       │
              │                                                 │
              │   DatabaseModule   ← DrizzleModule.forRoot      │
              │   ClsModule (+ ClsPluginTransactional)          │
              │   AuthModule       (login, guard, middleware)   │
              │   RequestContextModule  (CURRENT_USER, _ORG)    │
              │                                                 │
              │   OrganizationsModule                           │
              │   UsersModule       ← OnboardingModule          │
              │   ProjectsModule                                │
              │                                                 │
              │   AuditLogModule                                │
              │   OutboxModule  (producer, claimer, registry,   │
              │                  transport, user.invited handler)│
              │   OnboardingModule (OrganizationOnboardingService)│
              │                                                 │
              │   AppTrpcModule    ← TrpcModule.forRoot         │
              │     PingRouter, AuthRouter, OrganizationsRouter,│
              │     UsersRouter, ProjectsRouter                 │
              └─────────────────────────────────────────────────┘
```

The two libraries are wired exactly once each, via their primary `forRoot`
APIs:

- [`src/database/database.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/database.module.ts) →
  `DrizzleModule.forRoot({ schema, connection, shutdown })`.
- [`src/trpc/trpc.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/trpc/trpc.module.ts) →
  `TrpcModule.forRoot<AppTrpcContext>({ path, autoSchemaFile,
  createContext })`.

Feature modules declare their repositories via
`DrizzleModule.forFeature([…])` and their routers as providers. Routers are
ordinary `@Injectable()` classes (the `@Router('alias')` decorator from
`nest-trpc-native` applies `@Injectable()` automatically) — they accept
service deps through `@Inject(...)` in the constructor and call them.

> **DI gotcha:** `tsx`/`esbuild` does not reliably emit
> `design:paramtypes` metadata at dev/test runtime, even with
> `experimentalDecorators` and `emitDecoratorMetadata` set in `tsconfig`.
> Every constructor parameter that participates in DI uses an explicit
> `@Inject(Token)` in this repo. Without it, the dep silently resolves to
> `undefined` and you get `Cannot read properties of undefined (reading
> '...')` at the first method call. `tsc` builds emit the metadata
> correctly, so production builds work either way — but for consistency,
> every DI site here is explicit.

## Request lifecycle

```
┌─────────────────┐
│ HTTP request    │
└────────┬────────┘
         │
         v
  AuthMiddleware (express)              extracts Bearer token, verifies
         │                              via AuthService.resolve(), sets
         │                              req.authContext = { user, org }
         v
  ┌──────────────────────┐
  │ HTTP controller      │   ←── HealthController (no auth)
  │   - or -             │
  │ tRPC handler         │   ←── nest-trpc-native dispatch
  │   AuthGuard          │       reads ctx.authContext via getArgs()[1]
  │   ParamDecorators    │       @Input, @TrpcContext, @CurrentUser
  │   Procedure body     │
  └──────────────────────┘
         │
         v
  Service (request-scoped if it injects CURRENT_USER / CURRENT_ORGANIZATION)
         │
         v
  Repository (singleton; @InjectDrizzle for non-tx services,
              @InjectTransaction for any service that runs inside a
              @Transactional boundary so the active tx is honored)
```

The `AuthMiddleware` runs *before* the tRPC handler because tRPC is mounted
on top of Express. The middleware does the work once; both REST controllers
and tRPC procedures consume the same `authContext` shape.

`@CurrentUser()` and `@CurrentOrganization()` are param decorators that
read `authContext` from either `getArgs()[1]` (the tRPC context object,
populated by `TrpcModule.forRoot({ createContext })`) or
`switchToHttp().getRequest()` (the Express request). One implementation
serves both transports.

## Authentication

`AuthService.login(email, password)` runs `scrypt`-verify against the stored
hash, finds the first membership row for the user, and mints a real
HS256-signed JWT containing `{ sub: userId, org: orgId, iat, exp }`. The
signing key comes from `AUTH_SECRET` (min 32 chars, required in production,
deterministic dev fallback elsewhere).

JWT verification uses Node's built-in `node:crypto` HMAC — there's no JWT
library dependency. See
[`src/auth/jwt.ts`](https://github.com/nest-native/reference-app/blob/main/src/auth/jwt.ts) for the ~50-line implementation;
the test [`test/integration/auth-jwt.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/auth-jwt.spec.ts)
covers roundtrip, tamper, expiry, wrong-secret, malformed, and unsupported-algorithm cases.

Password hashing is `scrypt` with a 16-byte random salt; format is
`scrypt$<salt-hex>$<hash-hex>`. The same helpers are reused by
[`scripts/seed.ts`](https://github.com/nest-native/reference-app/blob/main/scripts/seed.ts) so seeded users can log in.

## The central transactional workflow

Brief §7's "single proof": `users.invite` writes across **five tables**
inside one `@Transactional()` method and queues a post-commit side effect.
The method is on
[`OrganizationOnboardingService`](https://github.com/nest-native/reference-app/blob/main/src/modules/onboarding/organization-onboarding.service.ts):

```
@Transactional()
inviteUser(input): Promise<Result> {
  1. upsert  users           (user)
  2. insert  memberships     (membership)
  3. insert  projects        (project)
  4. insert  audit_events    ("user.invited")
  5. insert  outbox_events   (topic: "user.invited", idempotency_key)
}
```

The whole method runs inside one SQLite transaction because:

- `AppModule` registers `ClsPluginTransactional` with our
  `SyncDrizzleTransactionalAdapter`.
- Every repo/service used inside the method injects the Drizzle client via
  `@InjectTransaction()` (the CLS proxy) instead of `@InjectDrizzle()` (the
  raw client). When the `@Transactional()` decorator enters the wrapper,
  the proxy resolves to the per-tx client; outside the wrapper it resolves
  to the raw client. The repo never sees the difference.

### Why a custom SyncDrizzleTransactionalAdapter

The official `@nestjs-cls/transactional-adapter-drizzle-orm` wraps the
inner Drizzle callback in `async`, which works for libsql and Postgres but
silently breaks `better-sqlite3` — its `client.transaction(fn)` is
synchronous and treats the async callback's immediately-returned `Promise`
as a successful sync return, so it commits an empty tx and the actual
writes happen *after* commit (against a closed tx).

Our adapter
([`src/database/sync-drizzle-transactional-adapter.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/sync-drizzle-transactional-adapter.ts))
keeps the inner callback synchronous and still returns a Promise from
`wrapWithTransaction` to satisfy the plugin contract. If you switch the app
to libsql or Postgres later, swap back to the official adapter — no other
code has to change.

### Rollback safety, exactly-once delivery

Three §7-mandatory tests in
[`test/integration/invite-user.workflow.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/invite-user.workflow.spec.ts):

- **Happy path:** all five rows persisted; outbox row visible after commit;
  worker tick processes it; `FakeEmailTransport` records the email.
- **Rollback safety:** force a throw between project insert and audit
  event; assert zero rows from this transaction persist; assert no email.
- **Worker crash recovery:** seed an outbox row with `status='processing'`
  and stale `claimed_at`; the next claimer tick re-claims it (under the
  stuck-timeout), processes it exactly once, and a follow-up tick is a
  no-op.

## Outbox

Schema is at
[`src/database/schema/outbox-events.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/schema/outbox-events.ts)
and matches brief §8: `pending | processing | completed | failed` status
machine, partial-unique `idempotency_key`, `(status, available_at)` claim
index, attempts/maxAttempts counters with backoff.

The flow has three pieces:

| Piece | File | Job |
| --- | --- | --- |
| Producer | [`outbox-producer.service.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/outbox-producer.service.ts) | `enqueue({ topic, payload, idempotencyKey? })` — inserts a `pending` row inside the active tx |
| Registry | [`outbox-registry.service.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/outbox-registry.service.ts) | `register(topic, handler)` — handler module init binds itself |
| Claimer | [`outbox-claimer.service.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/outbox-claimer.service.ts) | `tick()` — atomic claim (pending OR stuck processing), dispatch, mark completed/retry/failed |

The `user.invited` topic has exactly one handler
([`user-invited.handler.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/user-invited.handler.ts))
that delegates to `FakeEmailTransport`. In a real app, swap the transport
for SES, Sendgrid, etc.

## The worker process

[`scripts/start-worker.ts`](https://github.com/nest-native/reference-app/blob/main/scripts/start-worker.ts) boots a headless
Nest application context, resolves `OutboxClaimer` from DI, and ticks on
`OUTBOX_POLL_MS` (default 2s). `SIGTERM` and `SIGINT` abort an
`AbortController` that interrupts the in-flight wait, lets the current
tick drain, and closes the Nest container.

The loop body is exported as `runWorkerLoop(claimer, config)` so tests
exercise it without spawning child processes.

In production, run the API and the worker as two separate processes off the
same image (see `docker-compose.yml`).

## Layout (`src/`)

| Path | What's here |
| --- | --- |
| `main.ts` | Nest bootstrap — listens on `PORT` |
| `app.module.ts` | Root module: imports + ClsPluginTransactional wiring |
| `config/env.ts` | `loadEnv()` — single source of truth for env vars |
| `database/` | `DatabaseModule` (DrizzleModule.forRoot wiring), schema, migrations, custom sync CLS adapter |
| `auth/` | JWT helpers, scrypt password helpers, `AuthService`, middleware, `AuthGuard`, `@CurrentUser`/`@CurrentOrganization` decorators, `AuthRouter` |
| `context/` | `RequestContextModule` — Nest request-scoped `CURRENT_USER` / `CURRENT_ORGANIZATION` providers backed by `req.authContext` |
| `health/` | `/health` REST controller |
| `modules/organizations/` | Repo + service + tRPC router. `organizations.current` / `.list` |
| `modules/users/` | Repo + service + tRPC router. `users.me` / `.list` / `.invite` |
| `modules/projects/` | Repo + service + tRPC router. `projects.list` / `.get` / `.create` |
| `modules/memberships/` | Repo only (consumed by onboarding) |
| `modules/audit-log/` | `AuditLogService.record()` |
| `modules/outbox/` | Producer, claimer, registry, fake transport, `user.invited` handler, `outbox.constants.ts` |
| `modules/onboarding/` | `OrganizationOnboardingService` — the `@Transactional` workflow |
| `trpc/` | `AppTrpcModule` (TrpcModule.forRoot wiring), `PingRouter`, `generate-types.ts` |
| `@generated/server.ts` | Auto-generated from the routers (gitignored; regenerated by `npm run trpc:generate`) |

## Tests

| Path | Coverage |
| --- | --- |
| `test/integration/organizations.smoke.spec.ts` | Migration runs; `organizations` table queryable + unique constraint |
| `test/integration/core-schema.spec.ts` | Insert + constraint behavior for the other five tables |
| `test/integration/seed.spec.ts` | `seedDatabase` is idempotent; password hash is real scrypt |
| `test/integration/auth-jwt.spec.ts` | JWT sign/verify roundtrip, tamper, expiry, wrong-secret, malformed, unsupported alg |
| `test/integration/auth-password.spec.ts` | scrypt hash/verify positive + negative |
| `test/integration/core-schema.spec.ts` | (also) outbox partial-unique on `idempotency_key` |
| `test/integration/invite-user.workflow.spec.ts` | The three §7 tests (happy, rollback, crash recovery) |
| `test/integration/outbox-worker.spec.ts` | Worker loop drains pending; honors abort; survives tick errors |
| `test/e2e/auth-flow.spec.ts` | Login flow over real HTTP; 401 on wrong password / no token / bad token |
| `test/e2e/trpc-ping.smoke.spec.ts` | `GET /trpc/ping` returns 'pong'; `/health` returns ok |
| `test/e2e/core-modules.spec.ts` | Authenticated flow over real HTTP across the three core routers |

Plus `client-smoke/client.ts` (typed client over real HTTP using the
generated `AppRouter`) which is run via `npm run client-smoke` rather than
the test runner. It exercises one query, one mutation, and one
auth-protected call.

## Production deployment recipe

The default storage is `better-sqlite3` — zero-setup local dev. To run a
production deployment on Postgres:

1. Swap `drizzle-orm/better-sqlite3` for `drizzle-orm/node-postgres` (or
   `drizzle-orm/postgres-js`) in
   [`src/database/database.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/database.ts).
2. Swap `pragma('journal_mode = WAL')` etc. for the Postgres equivalents
   (typically nothing — set search_path if needed).
3. Replace `SyncDrizzleTransactionalAdapter` with the official
   `TransactionalAdapterDrizzleOrm` from
   `@nestjs-cls/transactional-adapter-drizzle-orm`. Postgres is async, so
   the original async-callback shape works.
4. Update the partial unique index on `outbox_events.idempotency_key` if
   the drizzle-kit output for Postgres differs (it usually doesn't for
   this shape).
5. Set `DATABASE_URL=postgres://…` in the environment. The Postgres
   sections in [`docker-compose.yml`](https://github.com/nest-native/reference-app/blob/main/docker-compose.yml) are commented
   for exactly this scenario.

Run API and worker as two processes off the same image:

```bash
# API
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://… \
  -e AUTH_SECRET=… \
  reference-app:latest

# Worker (same image, different command)
docker run --rm \
  -e DATABASE_URL=postgres://… \
  -e AUTH_SECRET=… \
  reference-app:latest node dist/scripts/start-worker.js
```

`docker-compose.yml` wires both as services with healthchecks and a shared
volume; comment out the SQLite path and uncomment the Postgres section to
switch.

## What this app deliberately is not

Re-stating the brief's non-goals because they shape what you should not
add here:

- **Not a CLI** (`create-nest-native-app`). Permanent maintenance cost,
  marginal value vs. a well-organized template repo.
- **Not the home of a standalone outbox package.** The outbox pattern
  lives here as an in-app module. A hypothetical `nest-outbox-native`
  extraction (no such package exists today) is only worth considering
  after three+ real apps independently rewrite the same shape — until
  then, every adopter forks this module's code rather than depending on
  a package.
- **Not a frontend.** The `client-smoke/` workspace is a typed-client
  smoke test, not a UI.
- **Not multi-database / GraphQL / micro-frontends.** Resist scope creep.

If a pattern repeats three times in this app, it's a candidate for one of
the upstream libraries — not for a local helper here.
