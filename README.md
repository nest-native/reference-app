# nest-native reference app

<p>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node version" />
  <img src="https://img.shields.io/badge/libraries-7%2F7-0f766e.svg" alt="All seven nest-native libraries" />
</p>

A production-shaped **multi-tenant work-tracking SaaS** — think a small Linear/Asana — that puts **all seven [nest-native](https://github.com/nest-native) libraries** under realistic backend pressure and composes them the way a real product would: persistence, a typed API, reliable domain events, an event backbone, deferred background jobs, a documented event catalog, and a streaming AI assistant.

It is not a product. It **serves the libraries** — a credible demo a team could adapt, and a feedback loop: if something feels awkward here, that's signal to add API in a separate PR to the relevant library (that's how, for example, `MessagingModule.forRoot`'s `imports` option and `KafkaInboxConsumer`'s `dedupKey` argument came to exist).

## The story

Follow one journey through the code and every library shows up where a real system would reach for it:

1. **An org invites a teammate.** `OrganizationOnboardingService.inviteUser()` writes the user + membership + project rows **and** enqueues a `user.invited` event — all in one transaction.
2. **They open a project and work tasks.** Create → assign → complete a task; each writes the task row **and** emits a `task.created` / `task.assigned` / `task.completed` domain event **in the same transaction** (no lost events, no phantom events).
3. **The events flow over Kafka.** A background claimer relays committed events to the broker; consumers turn them into an **activity feed** read-model — deduplicated, so an at-least-once redelivery never double-counts.
4. **Assigning schedules a reminder.** The same delivery that projects `task.assigned` into the feed also enqueues a delayed **assignment-reminder job** — in the same transaction, keyed by the event's dedup key — and the worker fires it exactly once when due. The queue is a table in the same database; no Redis.
5. **The event contracts are published.** An **AsyncAPI 3.0 catalog** at `/asyncapi` documents every event so another team could subscribe to your streams.
6. **AI reads the activity.** A streaming **project assistant** turns a project's recent activity into a status update, token by token.

## Seven libraries, seven chapters

| Library | Its job in the story | Where in the code |
| --- | --- | --- |
| [`@nest-native/drizzle`](https://github.com/nest-native/drizzle) | **Persistence** — orgs, users, projects, tasks, activity; repositories, transactions, multi-tenant scoping | `src/database/`, every `*.repository.ts` (`@DrizzleRepository`, `@InjectTransaction`) |
| [`@nest-native/trpc`](https://github.com/nest-native/trpc) | **The typed API** — task CRUD, project queries, the activity feed, all typesafe end-to-end; the superjson transformer keeps the feed's `Date`s real across the wire (the client link is *required* to match, at compile time), and failed validations reach the client as flattened Zod field errors (`error.data.zodError`) | `src/modules/*/**.router.ts` (`@Router`, `@Query`/`@Mutation`), `src/trpc/` (transformer, error formatting, response meta), generated `AppRouter` |
| [`@nest-native/messaging`](https://github.com/nest-native/messaging) | **Reliable domain events** — the transactional outbox (emit in-tx) + idempotent inbox (dedup on consume) | `src/modules/{outbox,inbox,activity}/`, `OutboxProducer.enqueue` inside `@Transactional()` |
| [`@nest-native/kafka`](https://github.com/nest-native/kafka) | **The event backbone** — the outbox relays through `KafkaOutboxTransport`; `@KafkaConsumer`s build read-models | the Kafka profile in `src/app.module.ts`, `src/modules/inbox/*.consumer.ts` |
| [`@nest-native/jobs`](https://github.com/nest-native/jobs) | **Deferred work** — the assignment reminder: enqueued in the same transaction as the `task.assigned` projection (`uniqueKey` = the event's dedup key), executed exactly once by the worker | `src/modules/reminders/`, `TaskAssignedProjection` in `src/modules/activity/`, `src/database/schema/jobs.ts` |
| [`@nest-native/asyncapi`](https://github.com/nest-native/asyncapi) | **The event catalog** — an AsyncAPI 3.0 doc so other teams integrate with your streams | `src/modules/events-catalog/`, served at `/asyncapi` from `src/main.ts` |
| [`@nest-native/ai-sdk`](https://github.com/nest-native/ai-sdk) | **AI over your data** — a streaming assistant that summarizes a project's activity | `src/modules/assistant/` (`@AiStream`), `POST /projects/:projectId/assistant` |

Underneath, [`@nestjs-cls/transactional`](https://www.npmjs.com/package/@nestjs-cls/transactional) (with the official Drizzle adapter) ties the outbox write to the business write — its `transactionMode: 'auto'` runs the same `@Transactional()` code against better-sqlite3's synchronous driver locally and an async driver in production.

## Two profiles, one codebase

Everything above runs **with no infrastructure** by default:

- **In-process (default)** — the outbox relays through an in-process transport and handlers build the activity feed synchronously. SQLite in a file, no broker. This is what the tests exercise.
- **Kafka** — set `KAFKA_BROKERS` and the exact same domain code relays through `KafkaOutboxTransport` to a real cluster, with `@KafkaConsumer`s on the other side. The event bodies, dedup keys, and wire headers are identical; only the transport swaps.

## Getting started

Requires **Node ≥ 22** (the AI SDK requires it).

```bash
nvm use
npm install
DATABASE_URL=./reference-app.db npm run db:migrate
DATABASE_URL=./reference-app.db npm run seed
AUTH_SECRET=dev-secret-must-be-at-least-32-characters-xxxxx \
  DATABASE_URL=./reference-app.db \
  npm run start:dev
```

The API listens on `http://localhost:3000`:

| Surface | Path |
| --- | --- |
| tRPC (typed API) | `/trpc` |
| Health | `/health` |
| AsyncAPI catalog (UI / JSON / YAML) | `/asyncapi`, `/asyncapi-json`, `/asyncapi-yaml` |
| AI project assistant (SSE stream) | `POST /projects/:projectId/assistant` |

The seed creates `admin@acme.test` / `admin123!` with a starter org + project. The AI assistant streams from an **offline mock model** by default; set `OPENAI_API_KEY` to swap in a real provider (`@ai-sdk/openai`) with no code change. Run the background worker — the outbox relay **and** the jobs queue in one process — with `npm run start:worker`.

## Walking the journey (curl)

```bash
# 1. create + assign + complete a task (tRPC) → each emits a domain event in-tx
#    (use the typed client in client-smoke/ for a real end-to-end example)
# 2. the outbox worker relays events; the activity feed fills up:
#    trpc: activity.list({ projectId })
#    (assigning also scheduled a deferred reminder job — the worker fires it
#     when due; tune with TASK_REMINDER_DELAY_MS)
# 3. inspect the event catalog other teams would integrate against:
curl localhost:3000/asyncapi-json | jq '.channels | keys'   # user.invited, task.created, task.assigned, task.completed
# 4. stream an AI status update for the project's activity:
curl -N -X POST localhost:3000/projects/1/assistant -H 'authorization: Bearer <jwt>'
```

## Repo layout

```
src/
  main.ts                  Nest bootstrap + AsyncApiModule.setup('/asyncapi', ...)
  app.module.ts            Root module, ClsPluginTransactional, in-process/Kafka messaging profiles
  config/env.ts            loadEnv() — single source of truth (incl. the optional kafka block)
  database/                DrizzleModule wiring + schema (orgs/users/projects/tasks/activity/...) + migrations
  auth/                    scrypt passwords, HS256 JWT, AuthGuard, middleware
  context/                 request-scoped CURRENT_USER / CURRENT_ORGANIZATION
  modules/
    organizations/ users/ projects/    repos + services + tRPC routers (tenant-scoped)
    tasks/                             the work-item domain — CRUD + lifecycle events
    activity/                          the event-fed activity feed read-model + router
    onboarding/                        OrganizationOnboardingService — the @Transactional invite flow
    outbox/ inbox/                     the messaging pair (in-process handlers + Kafka consumers)
    reminders/                         the @nest-native/jobs chapter — the deferred assignment reminder
    events-catalog/                    @nest-native/asyncapi event declarations
    assistant/                         @nest-native/ai-sdk streaming project assistant
    audit-log/ memberships/            supporting services
  trpc/                    TrpcModule.forRoot + routers + generated AppRouter
test/integration/          real-DB tests (node:test) — task workflow, dedup, reminder job, asyncapi, AI stream
client-smoke/              typed tRPC client over the generated AppRouter
docs/architecture.md       one-sitting tour
```

## Testing & quality gates

```bash
npm run test          # node --test: integration + e2e (real SQLite, offline)
npm run test:cov      # with c8 coverage
npm run ci            # typecheck, lint, complexity (≤15), test:cov, security:audit, build
```

Coverage here is **pragmatic, not 100%** — the 100% bar belongs to the libraries. The transactional workflow, the outbox worker, the inbox dedup, the reminder job's exactly-once scheduling and execution, the AsyncAPI catalog, and the AI stream all have explicit tests. CI runs on **Node 22**.

Two **optional, local-only** layers sit on top (neither runs in CI, and forks
work without them):

- **Full mode** — `npm run infra:up && npm run test:full` runs the base suite
  plus the gated live-Kafka e2e against a disposable Redpanda broker
  (`docker-compose.yml`, compose profile `kafka`, `127.0.0.1:19092`);
  `npm run infra:down` cleans up.
- **Mutation testing** — `npm run test:mutation` (incremental Stryker run;
  `test:mutation:full` re-tests everything). Scope with `STRYKER_MUTATE`,
  include the live-Kafka spec with `STRYKER_WITH_INFRA=1`.

Details — including the `KAFKA_BROKERS`-flips-the-app warning, the pre-PR
ritual, and agent instructions — in
[GUIDELINES_NEST_REFERENCE_APP.md](GUIDELINES_NEST_REFERENCE_APP.md#local-full-mode-verification-optional-infra--mutation-testing).

## Compatibility

| | Supported line |
| --- | --- |
| Node.js | `>=22` |
| NestJS | `11.x` |
| `@nest-native/drizzle` | `0.3.x` · `@nest-native/trpc` `0.6.x` · `@nest-native/kafka` `0.2.x` |
| `@nest-native/messaging` | `0.2.x` · `@nest-native/asyncapi` `0.1.x` · `@nest-native/ai-sdk` `0.4.x` (on `ai@7`) |
| Drizzle ORM | `0.45.x` · `@nestjs-cls/transactional` `^3` |

## Philosophy

- **Feel native.** Decorator-first, Nest modules + DI + enhancers, lifecycle hooks. No functional wrappers around library decorators.
- **Stay honest.** Drizzle stays SQL-first; tRPC stays tRPC; the outbox is a real table, not magic.
- **Every event has a home.** Emitted in-transaction (messaging), delivered over the backbone (kafka), documented (asyncapi), and consumed — including by the AI (ai-sdk).
- **Library fixes ship upstream.** Find a rough edge in a nest-native library while building here? Open the fix as a separate PR to that library, get it merged, then resume.

See [`docs/architecture.md`](docs/architecture.md) for the full tour and [CONTRIBUTING.md](CONTRIBUTING.md) for the design rules.
