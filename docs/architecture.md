---
layout: default
title: Architecture
description: One-sitting tour of the nest-native reference app — module graph, request lifecycle, the central @Transactional workflow, the outbox, and the worker.
---

# Architecture

This is a single-process Nest application (plus one background worker
process). It exists to demonstrate how all seven
[nest-native](https://github.com/nest-native) libraries —
[`trpc`](https://github.com/nest-native/trpc),
[`kafka`](https://github.com/nest-native/kafka),
[`jobs`](https://github.com/nest-native/jobs),
[`asyncapi`](https://github.com/nest-native/asyncapi),
[`ai-sdk`](https://github.com/nest-native/ai-sdk),
[`cache`](https://github.com/nest-native/cache), and
[`lockout`](https://github.com/nest-native/lockout) —
compose on the official [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle)
and [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox) modules
under realistic backend pressure: feature modules, multi-tenant
context, cross-service transactions, post-commit side effects via a
transactional outbox, deferred and scheduled work, a published event
catalog, and a typed tRPC client.

This document is meant to be read top-to-bottom in one focused sitting.
Each section answers one question.

## The problem this exists to solve

If you're starting a new NestJS backend and you've picked Drizzle for the
database and tRPC for the API layer, you have a **composition problem**.
Each library is well-documented in isolation — but a real backend is the
composition, and the composition is where most of the design decisions
live. Library docs cover their slice; nobody covers the seams.

This app is the seams, written out. Specifically, it commits to a
decision for each of the following questions that an adopter would
otherwise have to answer from scratch:

- **How does "current user" and "current organization" thread through
  everything?** Express middleware sets `req.authContext` on the way in.
  That value reaches a tRPC procedure via
  `TrpcModule.forRoot({ createContext })`, reaches a guard via
  `context.getArgs()[1]`, and reaches a service three calls deep via a
  request-scoped `CURRENT_USER` / `CURRENT_ORGANIZATION` provider in
  `RequestContextModule`. One auth middleware, four consumers, one
  shape. See [Request lifecycle](#request-lifecycle) and
  [Authentication](#authentication).

- **How does a transaction span services?** "Insert a user, insert a
  membership, insert a project, write an audit row, enqueue a side
  effect" is one business operation. Splitting it across services would
  normally either leak the tx through every method signature or leak
  the lack of one. `@nestjs-cls/transactional` keeps the active
  transaction in CLS, and every repo that participates injects the
  Drizzle client via `@InjectTransaction()` so it transparently uses
  the tx client inside a `@Transactional()` method and the raw client
  outside one. **There is one trap with `better-sqlite3`**: the
  driver is synchronous, so the `@Transactional()` method must be too —
  the official adapter (>=1.3.0) auto-detects this and runs the
  transaction in sync mode. See
  [Synchronous better-sqlite3 transactions](#synchronous-better-sqlite3-transactions).

- **How do you send a post-commit side effect without losing it?** You
  can't send the email inside the transaction (rollback → ghost email)
  and you can't send it from the request handler after the transaction
  either (process crashes → lost email). The transactional outbox is
  the answer, and NestJS ships one: the official `@nestjs/outbox` gets the
  leases, the fencing, the retries with backoff and the dead letters
  right. The app supplies the one piece it has no driver for, a store on
  SQLite. See [Outbox](#outbox) and [The worker process](#the-worker-process).

- **How do you keep the typed-client contract honest?** tRPC promises
  end-to-end type safety, but only if the generated `AppRouter` actually
  round-trips into a real client at CI time. This app's
  [`client-smoke/`](https://github.com/nest-native/reference-app/blob/main/client-smoke/client.ts)
  workspace imports the generated `AppRouter`, boots the app in-process,
  and runs one query + one mutation + one auth-protected call against a
  live local server. `client-smoke:typecheck` is in `npm run ci`.

- **What does the boring scaffolding actually look like?** Biome for lint
  and a cognitive-complexity ceiling of 15, `drizzle-kit`
  forward-only migrations, `node:test` + `c8` coverage, an `npm run ci`
  chain (`typecheck → lint → complexity → tests → audit → build`), a
  Dockerfile that runs both API and worker off the same image. All of
  it is in the repo from milestone 1, not added as an afterthought.

The point isn't that these are the only good answers. The point is that
**this app commits to specific answers**, so you can disagree with any
one of them and swap it out — but you're disagreeing with something
concrete rather than designing in a vacuum.

## Module graph

```
              ┌──────────────────────────────────────────────────┐
              │ AppModule                                        │
              │                                                  │
              │   DatabaseModule   ← DrizzleModule.forRoot       │
              │   AppCacheModule   ← CacheModule.forRootAsync    │
              │   ClsModule (+ ClsPluginTransactional)           │
              │   AuthModule       (login, guard, middleware,    │
              │                     AppLockoutModule)            │
              │   RequestContextModule  (CURRENT_USER, _ORG)     │
              │   AuditLogModule                                 │
              │                                                  │
              │   JobsModule.forRoot  +  RemindersModule         │
              │                                                  │
              │   ─ messaging profile (a broker env flips it) ─  │
              │   OutboxModule.forRoot / forRootAsync            │
              │     + SqliteOutboxStore (an AppModule provider)  │
              │     default:  the local transport →              │
              │               InProcessOutboxModule handlers     │
              │     kafka:    KafkaOutboxTransport,              │
              │               KafkaModule.forRootAsync + the     │
              │               UserInvited / TaskActivity inboxes │
              │     rabbitmq: RabbitOutboxTransport,             │
              │               RabbitmqConnectionModule + the     │
              │               RabbitmqInboxModule consumers      │
              │                                                  │
              │   OrganizationsModule                            │
              │   UsersModule       ← OnboardingModule           │
              │   ProjectsModule    TasksModule                  │
              │   ActivityModule    (the read-model + projection)│
              │                                                  │
              │   AppTrpcModule       ← TrpcModule.forRoot       │
              │     PingRouter, AuthRouter, OrganizationsRouter, │
              │     UsersRouter, ProjectsRouter, TasksRouter,    │
              │     ActivityRouter                               │
              │   EventsCatalogModule ← AsyncApiModule.forRoot   │
              │   AssistantModule     ← AiModule.forRoot         │
              └──────────────────────────────────────────────────┘
```

Each library is wired **exactly once**, via its primary `forRoot` /
`forRootAsync` API — the wiring site is the file to read first for that
chapter:

- [`src/database/database.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/database.module.ts) →
  `DrizzleModule.forRoot({ db })` from the official `@nestjs/drizzle`, which
  registers the database globally under `getDrizzleToken()` and closes its
  client on shutdown.
- [`src/trpc/trpc.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/trpc/trpc.module.ts) →
  `TrpcModule.forRoot<AppTrpcContext>({ path, autoSchemaFile,
  createContext })`.
- [`src/app.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/app.module.ts) →
  `OutboxModule.forRoot({ … })` from the official `@nestjs/outbox` — or
  `forRootAsync({ … })` when a broker transport needs its client — with the
  app's `SqliteOutboxStore` registered next to it as a provider; and — only
  when `KAFKA_BROKERS` is set — `KafkaModule.forRootAsync({ … })` plus the
  app's `KafkaOutboxTransport` and the inbox consumers; or — only when
  `RABBITMQ_URL` is set — the app's RabbitMQ connection,
  `RabbitOutboxTransport`, and the `RabbitInbox` subscribers in
  [`src/modules/rabbitmq/`](https://github.com/nest-native/reference-app/blob/main/src/modules/rabbitmq).
  Same file, every profile.
- [`src/app.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/app.module.ts) →
  `JobsModule.forRoot({ store, scheduleStore })`; the handlers and the
  bootstrap-declared cron schedule live in
  [`src/modules/reminders/`](https://github.com/nest-native/reference-app/blob/main/src/modules/reminders).
- [`src/modules/events-catalog/events-catalog.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/events-catalog/events-catalog.module.ts) →
  `AsyncApiModule.forRoot({ … })`, served at `/asyncapi` from `main.ts`.
- [`src/modules/assistant/assistant.module.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/assistant/assistant.module.ts) →
  `AiModule.forRoot({ … })` for the streaming project assistant.
- [`src/cache/cache.setup.ts`](https://github.com/nest-native/reference-app/blob/main/src/cache/cache.setup.ts) →
  `CacheModule.forRootAsync({ … })` (see [Read caching](#read-caching)).
- [`src/auth/lockout.setup.ts`](https://github.com/nest-native/reference-app/blob/main/src/auth/lockout.setup.ts) →
  `LockoutModule.forRootAsync({ … })` (see [Login lockout](#login-lockout)).

Feature modules list their repositories and routers as providers.
Repositories are plain `@Injectable()` classes. Routers are
ordinary `@Injectable()` classes (the `@Router('alias')` decorator from
`@nest-native/trpc` applies `@Injectable()` automatically) — they accept
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
  │ tRPC handler         │   ←── @nest-native/trpc dispatch
  │   AuthGuard          │       reads ctx.authContext via getArgs()[1]
  │   RolesGuard         │       re-reads the caller's membership row
  │                      │       (every guarded request — see Authorization)
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
hash, picks the user's **oldest** membership (ordered by `created_at`, then
`id` as the tiebreak — so repeated logins always land on the same tenant), and
mints a real HS256-signed JWT containing
`{ sub: userId, org: orgId, iat, exp }`. The signing key comes from
`AUTH_SECRET` (min 32 chars, required in production, deterministic dev fallback
elsewhere) and the lifetime from `AUTH_TTL_SECONDS` (default 3600; a NaN, zero
or negative value fails `loadEnv()` at boot instead of minting tokens that can
never verify).

JWT verification uses Node's built-in `node:crypto` HMAC — there's no JWT
library dependency. See
[`src/auth/jwt.ts`](https://github.com/nest-native/reference-app/blob/main/src/auth/jwt.ts) for the ~50-line implementation;
the test [`test/integration/auth-jwt.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/auth-jwt.spec.ts)
covers roundtrip, tamper, expiry, wrong-secret, malformed, and unsupported-algorithm cases.

Password hashing is `scrypt` with a 16-byte random salt; format is
`scrypt$<salt-hex>$<hash-hex>`. The same helpers are reused by
[`scripts/seed.ts`](https://github.com/nest-native/reference-app/blob/main/scripts/seed.ts) so seeded users can log in.
It is deliberately the **synchronous** `scryptSync` — a short, obviously-correct
helper reads better here — but that blocks the event loop for the duration of
every hash, so concurrent logins queue behind each other. A production adopter
should swap in an async hash or a worker pool; that is orthogonal to (not a
replacement for) the login lockout below, which limits how many attempts reach
the hash at all.

## Authorization (roles + tenancy)

The token says **who** is calling and **which** organization is active. It
deliberately says nothing about what the caller may do — that is re-read from
the database on every guarded request:

```
@Router('tasks')
@UseGuards(AuthGuard, RolesGuard)   ← composed left to right
export class TasksRouter {
  @Query(...)  list(...)            ← no @Roles: any live member may read
  @Roles('admin', 'member')
  @Mutation(...) create(...)        ← RolesGuard re-reads the membership row
}
```

[`RolesGuard`](https://github.com/nest-native/reference-app/blob/main/src/auth/roles.guard.ts)
resolves `MembershipsRepository.findByOrgAndUser(activeOrg, caller)` at request
time and throws `ForbiddenException` when the membership is missing (revoked)
or its role is not in the procedure's `@Roles(...)` list. The policy is
deliberately small — three roles, no policy engine, no per-resource ACLs:
`users.invite` is `admin` only; `tasks.create` / `.assign` / `.complete` and
`projects.create` accept `admin` or `member`; `viewer` reads only.

**Reads are guarded too.** A procedure without `@Roles` still needs a live
membership: the guard is on every tenant-scoped router (`tasks`, `projects`,
`users`, `organizations`, `activity`) and on the assistant controller, so a
revoked account loses the member roster, the project list, the activity feed and
the token-spending AI digest on its *next* request instead of keeping them for
up to `AUTH_TTL_SECONDS`. The cost is one indexed lookup per request; it is
deliberately not cached, because a stale allow is exactly the failure being
prevented. `auth.me` is the exception — it only echoes the token back.

Because the guard's dependency has to travel with the guard, the single
registration of `MembershipsRepository` lives in
[`MembershipsModule`](https://github.com/nest-native/reference-app/blob/main/src/modules/memberships/memberships.module.ts),
which `AuthModule` imports **and re-exports**.

Tenancy is proven at the write, not assumed from the token. Inside the same
transaction that writes the row, `TasksService.createTask` requires the
`projectId` to resolve *within the caller's org* and `assignTask` requires the
assignee to hold a membership *in that org*. Both refuse with exactly the error
a nonexistent id gets (`Project 42 not found` /
`User 42 is not a member of this organization`) — a distinct "belongs to
someone else" message would turn the API into a cross-tenant existence oracle.
Membership itself is only ever granted to a **new** account:
`OrganizationOnboardingService` refuses an invite whose email already has one,
so an admin cannot attach a stranger — or another tenant's admin — to their
organization without consent, and cannot manufacture an assignee that way. The
refusal reads the same for an address that is already a member here and for one
that belongs to another tenant; erasing the last signal (that an account exists
at all) needs a pending-invitation row the invitee accepts, which is the shape a
production app should reach for.

See [`test/integration/tenant-authz.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/tenant-authz.spec.ts)
and [`test/e2e/roles-authz.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/e2e/roles-authz.spec.ts).

## Login lockout

The auth flow is hardened with [`@nest-native/lockout`](https://github.com/nest-native/lockout)
(the `@authlock/core` engine). `AuthService.login` gates **before** the
credential check: `lockout.check({ email, ip })` throws a 429 (mapped by
`@nest-native/trpc` to `TOO_MANY_REQUESTS`) when either the email or the
source IP has crossed `LOCKOUT_LIMIT` failures; otherwise a failed
verification calls `reportFailure` and a success calls `reportSuccess`.
The counters live in a Drizzle table (`lockout_attempts`) on the same SQLite
database, written on the base connection — deliberately outside the request
transaction, so a failed attempt is recorded even when the login transaction
rolls back. Because tRPC carries no HTTP body for a guard to inspect, the
integration uses `LockoutService` in the handler rather than `LockoutGuard`
— the library's documented non-HTTP-transport recipe. See
[`src/auth/lockout.setup.ts`](https://github.com/nest-native/reference-app/blob/main/src/auth/lockout.setup.ts)
and [`test/e2e/auth-lockout.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/e2e/auth-lockout.spec.ts)
(N failures → 429; the correct password is refused while locked).

## Read caching

Expensive reads are cached with [`@nest-native/cache`](https://github.com/nest-native/cache)
(the `@stalefree/core` engine) at the **router seam** — the services stay
synchronous and cache-free. `projects.list/get` and `activity.list` wrap
their loaders with org-scoped keys and **tags**; mutations invalidate by tag:
`projects.create` evicts the org's project tag, and `ActivityService.record`
— the projection write site — evicts the project's feed tag, so the
event-driven feed invalidates its own cache the moment the handler writes a
row. Every entry carries a TTL (`CACHE_TTL_MS`, default 30s) as the delivery
backstop. In the default single-process profile the L1 is coherent by
definition; when the worker runs as a separate process, `CACHE_SOCKET_PATH`
wires `@stalefree/core/socket`'s unix-socket bus across the split. See
[`src/cache/cache.setup.ts`](https://github.com/nest-native/reference-app/blob/main/src/cache/cache.setup.ts)
and [`test/e2e/stalefree-cache.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/e2e/stalefree-cache.spec.ts)
(a ten-minute TTL makes any missed invalidation glaring — freshness within
seconds proves the tags did the work, not expiry).

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
  5. insert  outbox_messages (Outbox.add: topic "user.invited",
                              header x-idempotency-key)
}
```

The whole method runs inside one SQLite transaction because:

- `AppModule` registers `ClsPluginTransactional` with the official
  `@nestjs-cls/transactional-adapter-drizzle-orm`.
- Every repo/service used inside the method injects the Drizzle client via
  `@InjectTransaction()` (the CLS proxy) instead of `@InjectDrizzle()` (the
  raw client). When the `@Transactional()` decorator enters the wrapper,
  the proxy resolves to the per-tx client; outside the wrapper it resolves
  to the raw client. The repo never sees the difference.

### Synchronous better-sqlite3 transactions

`better-sqlite3` is a **synchronous** driver: its `client.transaction(fn)`
runs `fn` synchronously and rejects a callback that returns a `Promise` (an
async wrapper would commit an empty tx and run the writes *after* commit,
against a closed tx). So a `@Transactional()` method on `better-sqlite3`
must itself be synchronous — no `async`, no `await`.

The official `@nestjs-cls/transactional-adapter-drizzle-orm` (>=1.3.0)
handles this automatically: its `transactionMode` defaults to `'auto'`,
detects the synchronous driver, and runs the transaction in sync mode
(force it with `transactionMode: 'sync'` if auto-detection ever misses).
Async drivers — libsql, Postgres, MySQL — keep working unchanged, so no
code has to change when you switch.

> Historical note: before 1.3.0 the official adapter only supported async
> drivers, so this app shipped a ~30-line `SyncDrizzleTransactionalAdapter`
> workaround. That fix is now upstream
> ([nestjs-cls#572](https://github.com/Papooch/nestjs-cls/pull/572)) and the
> workaround has been removed.

### Rollback safety, exactly-once delivery

Three §7-mandatory tests in
[`test/integration/invite-user.workflow.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/invite-user.workflow.spec.ts):

- **Happy path:** all five rows persisted; the outbox message visible
  after commit; one relay run publishes it (deleting its row) and the
  handler's inbox records it; `FakeEmailTransport` records the email once.
- **Rollback safety:** force a throw between project insert and audit
  event; assert zero rows from this transaction persist; assert no email.
- **Worker crash recovery:** lease the message to a relay that died. While
  that lease lasts, a run claims nothing; once it has run out, the next
  run claims the message and publishes it exactly once, and a follow-up
  run is a no-op.

## Outbox

The domain events run on the official
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox) module. A
service adds its message inside the transaction that writes the business
rows, so both commit or neither does:

```ts
@Transactional<TransactionalAdapterDrizzleOrm<AppDatabase>>({
  behavior: 'immediate',           // it reads before it writes: see below
})
createTask(input: CreateTaskArgs): Promise<Task> {
  const task = this.repo.create({ … });
  this.outbox.add(this.db, {       // Outbox<AppDatabase>, this.db the CLS tx
    topic: 'task.created',
    payload,
    key: `task:${org.id}:${task.id}`, // a task's events, in commit order
    headers: { 'x-idempotency-key': `task.created:${org.id}:${task.id}` },
  });
  return task as unknown as Promise<Task>;
}
```

The relay then claims committed messages under a lease, publishes them,
deletes what it published, retries what failed with backoff (10 attempts,
waits doubling from 1 s to at most 1 min, each jittered between half and
all of that: 2 to 4 minutes in all), and moves what never succeeds — or
what a handler rejects with `NonRetryableMessageError` — to a dead-letter
table, where `OutboxDeadLetters` can list and requeue it. Each claim gets
its own fencing token, so a relay that stalled past its lease cannot
overwrite the work of the one that took over. A task's messages share an
ordering key, so they are published in the order they committed, a later
one held back while an earlier one is retried.

The module ships stores for PostgreSQL and MySQL. On SQLite the app
implements its two public storage contracts itself, in
[`sqlite-outbox.store.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/sqlite-outbox.store.ts),
on the tables in
[`src/database/schema/outbox.ts`](https://github.com/nest-native/reference-app/blob/main/src/database/schema/outbox.ts)
(migrated by drizzle-kit like every other table):

| Table | Holds |
| --- | --- |
| `outbox_messages` | The messages not yet published: payload, headers, ordering key, times as epoch ms, attempts and their history, and the lease (`lease_owner`, `lease_until`). `seq` (AUTOINCREMENT) numbers them in commit order. |
| `outbox_dead_letters` | Messages that ran out of attempts (`exhausted`) or were refused (`rejected`), with their failure history and their `seq`, so a requeued one goes back to its place in its key. |
| `outbox_inbox` | Which consumer processed which message id: an insert-if-absent on `(consumer, message_id)`. |

Every store method is synchronous, like better-sqlite3, so `Outbox.add()`
and `OutboxInbox.processInTransaction()` stay synchronous inside the app's
synchronous `@Transactional()` bodies. The store registers itself with the
module's `OutboxStorage` in its constructor; `AppModule` provides it once,
next to `OutboxModule`.

- **Proof.** [`sqlite-outbox-store.contract.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/sqlite-outbox-store.contract.spec.ts)
  runs the module's own contract suites (`@nestjs/outbox/testing`) against
  the store, on the app's real migrations — all but the three cases that
  open a second transaction on the one connection.
  [`sqlite-outbox-store.cross-process.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/sqlite-outbox-store.cross-process.spec.ts)
  takes two of those to a second process holding the write lock: keyed
  messages numbered in commit order, whether the producer's transaction
  took the lock at `BEGIN` or at its first write, and two deliveries of a
  message meeting at the inbox key, after a commit and after a rollback. It
  also shows a claim waiting for the lock. The third, producers and relays
  racing over a key, is not repeated across processes; it rests on the
  same single writer.
- **Two processes, one file.** The API and the worker write the same SQLite
  file. SQLite has a single writer, so `seq` follows commit order across
  both processes with no lock per key, and the store's own multi-statement
  transactions open with `BEGIN IMMEDIATE`: they wait for the other
  process's lock instead of failing with `SQLITE_BUSY_SNAPSHOT`. The API's
  producers read before they write (the project, the membership, the
  invitee's email), so their `@Transactional()` methods ask for
  `BEGIN IMMEDIATE` as well: a deferred transaction that has read fails at
  once with `SQLITE_BUSY` when the worker holds the lock, where an
  immediate one waits for it
  ([`producers.cross-process.spec.ts`](https://github.com/nest-native/reference-app/blob/main/test/integration/producers.cross-process.spec.ts)).
  The worker's handlers and inbox engines write first, and wait at that
  write.
- **Production stance.** One SQLite file on one host is this demo's setup.
  The module's production checklist keeps the outbox on a database server
  — a container's disk goes away with the container — and the
  [Postgres recipe](#production-deployment-recipe) below swaps this store
  for the module's `PostgresOutboxStore`.

The consumers dedupe on the message id. In-process,
[`user-invited.handler.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/user-invited.handler.ts)
and [`activity.handler.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/activity.handler.ts)
are `@OnOutboxMessage()` methods, each with an inbox under its consumer
name; the activity handler records its inbox entry in the projection's own
transaction (`ctx.processInTransaction()`), so a redelivery never writes a
second feed row. Over a broker, the app's transports put the message id in
`x-event-id` and the business key in `x-idempotency-key` (the wire contract
in [`wire-contract.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/wire-contract.ts)),
and the consumers' engines (`KafkaInbox`, `RabbitInbox`) record each
delivery with `OutboxInbox.processInTransaction()` in the transaction that
applies it. In a real app, swap `FakeEmailTransport` for SES, Sendgrid, etc.

Nothing deduplicates a business key on the producer's side, so every
transition is an event of its own: the feed keys its row on the event's
business key and message id, and the assignment reminder its `uniqueKey`,
so a task assigned back to an earlier assignee, or reopened and completed
again, gets a row (and a reminder) each time. A transition that changes
nothing — assigning a task to the user working on it, completing a done
task — is refused with a 409 instead of being published twice. The inboxes
grow by a record per message and consumer; a nightly schedule on the jobs
library ([`inbox-prune.job.ts`](https://github.com/nest-native/reference-app/blob/main/src/modules/outbox/inbox-prune.job.ts))
prunes the records older than 30 days with `OutboxInbox.prune()`, which
nothing in the module calls for you.

> Upgrading a database the app ran on before the official outbox: stop the
> old worker first, then migrate. Migration 0008 carries the unpublished
> events over with their ids, the events the old worker gave up on as dead
> letters (`exhausted` or `rejected`, which `OutboxDeadLetters` lists and
> requeues), and the consumers' inbox records with their names; 0009 drops
> the old `outbox_events` and `inbox_events` tables, in the same
> transaction. A worker still running the old code could publish a
> carried-over event a second time. The Kafka and RabbitMQ consumers would
> deduplicate it on their carried-over inboxes; the in-process handlers
> would not, since the old ones kept no inbox, so its invite email would be
> sent again and its feed row written again.

## The worker process

[`scripts/start-worker.ts`](https://github.com/nest-native/reference-app/blob/main/scripts/start-worker.ts) boots a headless
Nest application context and runs the two queues side by side: it starts
the outbox relay (`OutboxRelay.start()`), which polls on `OUTBOX_POLL_MS`
(default 2s) and drains at once while batches come back full, and it runs
the jobs loop from `@nest-native/jobs`. `AppModule` keeps the relay off in
every process, so the API never publishes and the tests flush the outbox
with `relay.runOnce()`.

`SIGTERM` and `SIGINT` stop both: the relay stops claiming at once, and the
jobs loop returns once the job it is running ends. Then the worker closes
the Nest container, which waits for the relay's stop (`onModuleDestroy`) —
in-flight publishes settle and the leases on messages it had not started
are released — before the broker connections close
(`onApplicationShutdown`).

In production, run the API and the worker as two separate processes off the
same image (see `docker-compose.yml`).

## Layout (`src/`)

| Path | What's here |
| --- | --- |
| `main.ts` | Nest bootstrap — listens on `PORT` |
| `app.module.ts` | Root module: imports + ClsPluginTransactional wiring, `OutboxModule` in each messaging profile, the `SqliteOutboxStore` provider |
| `config/env.ts` | `loadEnv()` — single source of truth for env vars |
| `database/` | `DatabaseModule` (DrizzleModule.forRoot wiring), schema, migrations |
| `auth/` | JWT helpers, scrypt password helpers, `AuthService`, middleware, `AuthGuard` + `RolesGuard`/`@Roles`, `@CurrentUser`/`@CurrentOrganization` decorators, `AuthRouter` |
| `context/` | `RequestContextModule` — Nest request-scoped `CURRENT_USER` / `CURRENT_ORGANIZATION` providers backed by `req.authContext` |
| `health/` | `/health` REST controller |
| `modules/organizations/` | Repo + service + tRPC router. `organizations.current` / `.list` |
| `modules/users/` | Repo + service + tRPC router. `users.me` / `.list` / `.invite` |
| `modules/projects/` | Repo + service + tRPC router. `projects.list` / `.get` / `.create` |
| `modules/memberships/` | Repo + the one registration of it, re-exported through `AuthModule` (consumed by onboarding, `RolesGuard`, and the task tenancy checks) |
| `modules/audit-log/` | `AuditLogService.record()` |
| `modules/outbox/` | `SqliteOutboxStore` (the official outbox's store on SQLite), the wire contract, `KafkaOutboxTransport`, the in-process `@OnOutboxMessage()` handlers and `FakeEmailTransport`, `outbox.constants.ts` |
| `modules/inbox/` | The Kafka consumers, their `KafkaInbox` engine, and the read-side effects every profile shares (`TaskActivityProjections`, the invite audit) |
| `modules/rabbitmq/` | The RabbitMQ profile: connection, topology, `RabbitOutboxTransport`, the `RabbitInbox` engine and its subscribers |
| `modules/onboarding/` | `OrganizationOnboardingService` — the `@Transactional` workflow |
| `trpc/` | `AppTrpcModule` (TrpcModule.forRoot wiring), `PingRouter`, `generate-types.ts` |
| `@generated/server.ts` | Auto-generated from the routers (gitignored; regenerated by `npm run trpc:generate`) |

## Tests

| Path | Coverage |
| --- | --- |
| `test/integration/organizations.smoke.spec.ts` | Migration runs; `organizations` table queryable + unique constraint |
| `test/integration/core-schema.spec.ts` | Insert + constraint behavior for the other four tables |
| `test/integration/seed.spec.ts` | `seedDatabase` is idempotent; password hash is real scrypt |
| `test/integration/auth-jwt.spec.ts` | JWT sign/verify roundtrip, tamper, expiry, wrong-secret, malformed, unsupported alg |
| `test/integration/auth-password.spec.ts` | scrypt hash/verify positive + negative |
| `test/integration/invite-user.workflow.spec.ts` | The three §7 tests (happy, rollback, crash recovery) |
| `test/integration/outbox-relay.spec.ts` | A started relay drains on its own timer and stops promptly; a failed claim is logged and the relay keeps polling; closing the app stops it |
| `test/integration/sqlite-outbox-store.contract.spec.ts` | The official outbox's contract suites against `SqliteOutboxStore`, and batches and id lists past what one statement binds |
| `test/integration/sqlite-outbox-store.cross-process.spec.ts` | A second process holding the write lock: a claim waits for it, keyed messages are numbered in commit order (lock taken at `BEGIN` or at the first write), and two deliveries of a message meet at the inbox key |
| `test/integration/producers.cross-process.spec.ts` | The API's producers (`createTask`, `assignTask`, `completeTask`, `inviteUser`) wait for the worker's write lock instead of failing with `SQLITE_BUSY` |
| `test/integration/worker-shutdown.spec.ts` | The worker in a child process: a `SIGTERM` during a long job stops the relay at once, lets the job finish, and exits cleanly |
| `test/integration/rabbit-outbox-transport.spec.ts`, `rabbit-inbox.spec.ts` | The RabbitMQ transport and inbox engine on fake channels: confirms, returns and nacks; the 2^53 id, the `x-error` cap, a failed dead-letter copy, `retry.maxAttempts` |
| `test/integration/inbox-prune.spec.ts` | The nightly inbox prune: its schedule, and an occurrence deleting records older than 30 days |
| `test/integration/outbox-carry-over.spec.ts` | Migrations 0008–0009 carry the old outbox's unpublished events, its failed ones (as dead letters) and its inbox records over, then drop its tables |
| `test/e2e/auth-flow.spec.ts` | Login flow over real HTTP; 401 on wrong password / no token / bad token |
| `test/e2e/trpc-ping.smoke.spec.ts` | `GET /trpc/ping` returns 'pong'; `/health` returns ok |
| `test/e2e/core-modules.spec.ts` | Authenticated flow over real HTTP across the three core routers; a task title no database stores is a 400, a transition that changes nothing a 409 |
| `test/integration/tenant-authz.spec.ts` | Cross-org project/assignee are refused like missing ones, nothing committed; an invite cannot attach an existing account; login picks the oldest membership |
| `test/e2e/roles-authz.spec.ts` | RBAC over real HTTP: viewer/member/admin limits, and a revoked membership blocking the next request — reads and the AI assistant included |
| `test/integration/auth-context.spec.ts` | The guards' caller extractor: tRPC reads the procedure context, never the caller's input |

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
3. Give every client the pool opens an `error` listener, and the pool one
   of its own. drizzle-orm's node-postgres `transaction()` checks a client
   out without one (pg-pool drops its idle listener at checkout), so a
   connection the server drops mid-transaction (a failover, a restart,
   `pg_terminate_backend`) ends the process
   ([drizzle-orm#6437](https://github.com/drizzle-team/drizzle-orm/issues/6437)):

   ```ts
   pool.on('error', (error) => logger.warn(`idle client lost: ${error.message}`));
   // 'connect' fires once per new client, before its first checkout.
   pool.on('connect', (client) => {
     client.on('error', (error) => logger.warn(`client lost: ${error.message}`));
   });
   ```

   The transactional adapter needs no change: `TransactionalAdapterDrizzleOrm`
   detects the async driver on its own (`transactionMode: 'auto'`).
4. Swap the app's `SqliteOutboxStore` for the official
   `PostgresOutboxStore` from `@nestjs/outbox/postgres`, which keeps its
   tables in a schema of its own (`nest_outbox`), so the `outbox_*` tables
   leave the Drizzle schema:

   ```ts
   {
     provide: PostgresOutboxStore,
     inject: [getDrizzleToken(), OutboxStorage],
     useFactory: (db: Database, storage: OutboxStorage) =>
       new PostgresOutboxStore({ executor: fromDrizzle(db) }, storage),
   }
   ```

   Apply its migrations on deploy with `npx nest-outbox migrate` (and check
   them in CI with `npx nest-outbox status`), or paste
   `PostgresOutboxStore.migrationSql({ statementBreakpoints: true })` into a
   custom drizzle-kit migration. Keep the server's default isolation level
   at READ COMMITTED: the store refuses a stricter one at startup. On the
   async driver, `outbox.add()` and `processInTransaction()` return
   promises: await them before the transaction commits.
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
- **Not the home of an outbox package.** The outbox is the official
  `@nestjs/outbox` module. The app ships only the SQLite store the module
  has no driver for, written against its public store contract and proven
  by its contract suites — not a fork of the module.
- **Not a frontend.** The `client-smoke/` workspace is a typed-client
  smoke test, not a UI.
- **Not multi-database / GraphQL / micro-frontends.** Resist scope creep.

If a pattern repeats three times in this app, it's a candidate for one of
the upstream libraries — not for a local helper here.
