# CLAUDE.md

@GUIDELINES_NEST_REFERENCE_APP.md

The imported guidelines are binding. Two always-on rules:
- Stryker mutation testing and the full local flow (`infra:up` + `test:full`) are local-only — never wire them into CI. A live-broker spec runs in CI only in its own job, against one real broker, through `scripts/run-gated-strict.mjs`, which fails if the spec skipped (today: the `rabbitmq-e2e` and `kafka-e2e` jobs).
- Mutation testing is an **occasional, targeted audit — not a per-PR gate**. Run it deliberately when you've reworked a file's logic: scope with `STRYKER_MUTATE` to that one file, `--concurrency 2`, and verify a kill by hand-applying the mutation + running the plain suite (see the guidelines' Mutation testing section).
