// Mutation testing — LOCAL ONLY, on demand. Deliberately not wired into CI.
// See README.md, "Testing & quality gates" → "Local full-mode verification".
//
//   npm run test:mutation                    incremental (the pre-PR ritual)
//   npm run test:mutation:full               every mutant from scratch
//   STRYKER_MUTATE='src/config/**'           scope to the files you changed
//                                            (comma-separated globs)
//   STRYKER_WITH_INFRA=1                     run the gated live-Kafka e2e per
//                                            mutant too (`npm run infra:up`
//                                            first; forces concurrency 1)
const withInfra = process.env.STRYKER_WITH_INFRA === '1';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: process.env.STRYKER_MUTATE
    ? process.env.STRYKER_MUTATE.split(',')
    : ['src/**/*.ts'],
  testRunner: 'command',
  // `test:mutant` = the normal suite plus `--test-force-exit`: a mutant that
  // breaks teardown would otherwise leave open handles and turn every kill
  // into a slow timeout.
  commandRunner: {
    command: withInfra ? 'npm run test:mutant:full' : 'npm run test:mutant',
  },
  // Each command-runner mutant already runs the suite's test files in
  // parallel (node --test child processes), so high Stryker concurrency
  // oversubscribes the CPU and turns kills into timeouts. With infra,
  // concurrency must be 1 — the gated e2e shares the one broker.
  concurrency: withInfra ? 1 : 4,
  // The app suite is slow by nature (~4-18s per run: real SQLite,
  // outbox/poller timers) but its own file-level parallelism is modest, so
  // concurrency 4 holds on a 16-core box (measured smoke: 104 mutants,
  // 0 timeouts). Stryker adds the measured dry-run time on top of this
  // value, which is why the slow suite still fits; raise it if a slower
  // machine starts reporting timeouts instead of kills.
  timeoutMS: 15000,
  incremental: true,
  ignorePatterns: [
    'client-smoke',
    'docs',
    'coverage',
    '**/dist',
    '**/@generated',
  ],
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: { high: 90, low: 80, break: null },
  tempDirName: '.stryker-tmp',
};
