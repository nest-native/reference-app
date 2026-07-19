# GUIDELINES_NEST_REFERENCE_APP.md

## Core Philosophy - This app SERVES the eight nest-native libraries

This is `nest-native/reference-app`: a production-shaped, multi-tenant
work-tracking SaaS whose only job is to put **all eight
[nest-native](https://github.com/nest-native) libraries** — `drizzle`, `trpc`,
`messaging`, `kafka`, `jobs`, `asyncapi`, `ai-sdk`, and `lockout` — under
realistic backend pressure and show how they compose. It is **read first and
run second**. Every decision optimizes for a reader who wants to lift a pattern
into their own app.

Follow these assumptions in **EVERY** file you generate or modify. This is the
app's constitution.

### 1. What This App Is (and Is Not)

- It **serves the libraries**. Every module exists to exercise one of the eight
  under realistic pressure — persistence, a typed API, reliable domain events,
  an event backbone, deferred jobs, a documented event catalog, a streaming AI
  assistant, and brute-force login lockout.
- It is **not** a product, **not** a starter or scaffold, and **not** a generic
  NestJS boilerplate. There is no CLI, no second frontend, no multi-database
  story, no GraphQL — those are deliberate omissions, not gaps to fill.
- It is optimized for **being read**. A team adopting a library should open the
  relevant chapter, understand the pattern, and copy **the pattern** into their
  own app — not clone this repo. Clarity beats cleverness; an explicit path
  beats a clever helper.
- Stay **honest about each library**. Drizzle stays SQL-first, tRPC stays tRPC,
  the outbox is a real database table. No functional wrappers around library
  decorators, no local shims that hide what a library actually does.
- Use only each library's **primary onboarding API** (`*.forRoot()` /
  `forRootAsync()` / `forFeature()`, the public decorators). Reaching into a
  package's internals is a smell — if you need an internal, the public API has a
  gap (see Rule 2).

### 2. The Feedback Loop (an awkward seam here is a library bug)

- The app is a **feedback instrument** for the libraries. When a pattern feels
  awkward *here*, that friction is signal about a library's public API — not
  something to paper over locally.
- The workflow when a rough edge shows up: **stop**, open the fix as its **own
  separate PR to the relevant library**, get it merged and released, then resume
  here against the improved API. `MessagingModule.forRoot`'s `imports` option
  and `KafkaInboxConsumer`'s `dedupKey` argument exist precisely because
  building here made the gap visible.
- Do **not** work around a library limitation with a local shim, a private-API
  reach, or a copy-pasted internal. A workaround hides the exact signal this app
  exists to produce.

### 3. Pragmatic Coverage (100% and full-src mutation are NON-goals)

- Coverage here is deliberately **pragmatic, not 100%**. The 100%-coverage bar
  belongs to the **libraries**; this app's job is to prove they compose.
  Chasing 100% here would add test noise that teaches nothing about the
  integration.
- What **does** earn explicit tests: the transactional invite/task workflow, the
  outbox relay, inbox dedup, the reminder job's exactly-once scheduling and
  execution, the AsyncAPI catalog, and the AI stream — the seams where libraries
  meet.
- Mutation testing runs **scoped and on-demand**, never across the whole `src/`
  tree by default and never in CI. **Full-source mutation is an explicit
  non-goal**; the useful signal is *which mutants survive* on the files a change
  actually touched. See the local full-mode section below.

### 4. Two Messaging Profiles (KAFKA_BROKERS flips the WHOLE app)

- **In-process (default).** The outbox relays through an in-process transport
  and handlers build the activity feed synchronously — SQLite in a file, no
  broker. This is the profile `npm run test` exercises.
- **Kafka.** Setting `KAFKA_BROKERS` makes the *exact same domain code* relay
  through `KafkaOutboxTransport`, with `@KafkaConsumer`s on the other side.
  Event bodies, dedup keys, and wire headers are identical; only the transport
  swaps.
- `KAFKA_BROKERS` is a **whole-app switch**, not a per-spec flag. **Never export
  it around the base `npm run test`** — it flips the entire app into the Kafka
  profile and breaks the in-process integration specs. The dedicated
  `test:kafka` / `test:full` scripts set it for the live-Kafka spec only and
  keep the two halves isolated for you.

### 5. The Worker Model (one process drains outbox + jobs)

- A **single** background worker process drains **both** the messaging outbox
  relay **and** the jobs queue — `npm run start:worker`. There is intentionally
  one worker, not one process per concern.
- Both queues are **tables in the same database** — no Redis. The
  assignment-reminder job is enqueued in the same transaction as the
  `task.assigned` projection (its `uniqueKey` is the event's dedup key), and the
  worker fires it exactly once when due.
- Keep the drain loop honest: the worker is a plain process reading committed
  rows, not a magic scheduler. It is part of the pattern teams copy, so it stays
  legible.

### 6. When In Doubt

- Ask: *"Does this make the libraries' integration clearer to a reader, and does
  it keep each library feeling like itself?"* If not, redesign until it does.
- Ask: *"Is this friction a library API gap?"* If yes, it ships upstream as its
  own PR — not as a local workaround here.

For the day-to-day validation gate, see the README's "Testing & quality gates"
section. The optional, local-only verification layers live below.

## Local Full-Mode Verification (optional infra + mutation testing)

Everything in this section is **opt-in and local-only**. Plain `npm test` and
CI run without Docker — the live-Kafka e2e self-skips, and forks work out of the
box. **CI never runs any of this** (neither the broker-backed spec nor mutation
testing); it is an on-demand local gate, and that is deliberate.

### Gated live-Kafka e2e (real Redpanda broker)

```bash
npm run infra:up      # disposable Redpanda broker on 127.0.0.1:19092 (compose profile `kafka`)
npm run test:full     # base suite (SQLite, in-process messaging) + the live-Kafka spec
npm run test:kafka    # just the live-Kafka spec
npm run infra:down    # removes the broker container and volume
```

- `infra:up` starts only the `redpanda` service from `docker-compose.yml` (its
  `kafka` compose profile) and waits for its healthcheck (a few seconds), so a
  plain `docker compose up` keeps the default SQLite / in-process stack.
- `test:kafka` runs `test/integration/reliable-messaging.kafka.spec.ts` with
  `KAFKA_BROKERS=localhost:19092` and `KAFKA_TOPIC_PREFIX=reliable-e2e.` set for
  that spec only. It proves the Reliable Messaging Pair end to end: a
  transactional enqueue → the outbox claimer publishes to Kafka → the inbox
  consumer deduplicates → exactly one audit row, even after a forced redelivery.
- **AUTH_SECRET compose interpolation.** `infra:up` / `infra:down` prefix
  `AUTH_SECRET=${AUTH_SECRET:-infra-only-placeholder}` because the app and worker
  services in `docker-compose.yml` interpolate a *required*
  `${AUTH_SECRET:?…}`. Docker Compose evaluates that interpolation while parsing
  the whole file — even though you are only starting the `redpanda` service —
  and aborts if the variable is unset. The placeholder just satisfies that
  parse-time check; it never reaches the broker.
- Do **not** export `KAFKA_BROKERS` globally around the base `npm run test`:
  setting it flips the whole app into the Kafka messaging profile and breaks the
  in-process integration specs. `test:full` keeps the two halves isolated for
  you.

### Mutation testing (Stryker — occasional targeted audit, local only, never in CI)

Run it **deliberately, scoped to a file whose logic you reworked** — not on
every PR (full-source mutation is a non-goal here, per Rule 3). The useful
signal is *which mutants survive* on the file you touched.

```bash
npm run test:mutation        # incremental run (cache: reports/stryker-incremental.json)
npm run test:mutation:full   # every mutant from scratch (--force)
```

- `STRYKER_MUTATE='src/modules/audit-log/**,src/config/env.ts'` —
  comma-separated globs to scope a run to the files a change touched.
- `STRYKER_WITH_INFRA=1` — each mutant also runs the live-Kafka spec (`npm run
  infra:up` first; concurrency is forced to 1 because the spec shares the one
  broker). Slow by design; use it for messaging-adjacent changes.
- Report: `reports/mutation/mutation.html`. Thresholds are advisory
  (`break: null`) — the signal is *which mutants survive*, not the score.
- Per-mutant runs use `test:mutant` / `test:kafka:mutant` (the normal commands
  plus `--test-force-exit`) so a mutant that breaks teardown dies instead of
  hanging into a timeout.

**Verify a kill without re-running Stryker — the fast path.** Hand-apply the
surviving mutation to the source, run the plain suite (or just the one spec),
confirm your new test fails, then `git checkout --` to revert. This decouples
the slow "find survivors" step from a fast "prove the kill" step. If a run times
out, `kill -9` any leftover `stryker` processes before retrying — a killed run
can leave detached test processes that starve the next one.

### AI agents working on this repo

- When Docker is available, run `npm run infra:up && npm run test:full` before
  opening a PR that touches `src/`, and report the result (including the
  live-Kafka spec) in the PR body. When Docker is not available, run `npm test`
  and state that the live-Kafka spec was skipped.
- Mutation testing is an **occasional, targeted audit — not a per-PR gate**.
  When you've reworked a file's logic, scope `STRYKER_MUTATE` to it and verify
  kills by hand-applying the mutation + running the suite; note anything found
  in the PR body. Do not run it routinely.
- Never wire any of this into CI — CI stays fast and Docker-free, and forks are
  unaffected.
