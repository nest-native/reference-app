#!/usr/bin/env node
/**
 * Roster/version gate for the repo's own metadata.
 *
 * This app's whole point is that it exercises every nest-native library, so
 * "which libraries, at which versions" is a claim it makes in three places
 * that drift apart silently: the README compatibility table, the package.json
 * description, and the docs/ Pages site. Two of those are machine-checkable
 * against the one source of truth — the dependency ranges in package.json —
 * and that is what this script does:
 *
 *   1. every version literal in the README "Compatibility" table matches the
 *      range that package.json actually declares for that package;
 *   2. every @nest-native/* dependency has a row in that table;
 *   3. the package.json description names every @nest-native/* dependency and
 *      states the right library count ("all nine ...");
 *   4. the README's libraries-N/N badge counts the same roster;
 *   5. the docs/ Pages site names every library and states the same count.
 *
 * Everything is derived from the dependencies package.json declares — nothing
 * here hardcodes a library name, so adding the tenth library fails this check
 * everywhere it has not been mentioned yet.
 *
 * Wired into `npm run ci` as `npm run docs:check`. Exits non-zero on the first
 * failing run with one line per problem.
 *
 * Usage: node scripts/check-compat-table.mjs [--help]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'docs:check';
const SCOPE = '@nest-native/';
const HEADING = '## Compatibility';
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.warn(
    [
      'Usage: node scripts/check-compat-table.mjs',
      '',
      'Checks the README compatibility table and the package.json description',
      'against the dependency ranges package.json declares. No arguments.',
    ].join('\n'),
  );
  process.exit(0);
}

const read = (relativePath) =>
  readFileSync(join(repoRoot, relativePath), 'utf8');

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const site = read('docs/index.html');

const declaredRanges = new Map(
  Object.entries({
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }),
);
const libraries = [...declaredRanges.keys()]
  .filter((name) => name.startsWith(SCOPE))
  .sort();

const problems = [];
const checked = [];
const fail = (message) => problems.push(message);

/** `^0.4.0` / `0.45.2` / `>=22` -> ['0', '4', '0'] */
function rangeParts(range) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  return match ? match.slice(1) : [];
}

/**
 * True when a README version literal covers the declared range.
 * Accepts `0.4.x` (major+minor), `^3` / `3.x` / `3` (major), `0.45.2` (exact).
 */
function literalCovers(literal, range) {
  const [rMajor, rMinor, rPatch] = rangeParts(range);
  const cleaned = literal.replace(/^[\^~]/, '');
  const [lMajor, lMinor, lPatch] = cleaned.split('.');

  if (lMajor === undefined || !/^\d+$/.test(lMajor)) return false;
  if (lMajor !== rMajor) return false;
  if (lMinor === undefined) return true;
  if (lMinor === 'x' || lMinor === '*') return true;
  if (lMinor !== rMinor) return false;
  if (lPatch === undefined || lPatch === 'x' || lPatch === '*') return true;
  return lPatch === rPatch;
}

const isVersionLiteral = (span) => /^[\^~]?\d/.test(span);

/**
 * Pull (package, version) pairs out of the table's code spans. Within a row a
 * version literal binds to the package named just before it, so both
 * "`pkg` `0.4.x`" and "`pkg` `0.1.x` (on `other/pkg` `0.1.x`)" pair up, while
 * label-only rows ("Node.js | `>=22`") contribute nothing.
 */
function pairsFrom(tableLines) {
  const pairs = [];
  for (const line of tableLines) {
    let current = null;
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      const scoped = /^(@[^@/\s]+\/[^@\s]+|[^@/\s]+)@(.+)$/.exec(span);
      if (scoped) {
        pairs.push({ name: scoped[1], literal: scoped[2], line });
        current = null;
      } else if (isVersionLiteral(span)) {
        if (current) pairs.push({ name: current, literal: span, line });
        current = null;
      } else {
        current = span;
      }
    }
  }
  return pairs;
}

function compatibilityTable() {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === HEADING);
  if (start === -1) {
    fail(`README.md has no "${HEADING}" section`);
    return [];
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = section.filter((line) => line.trim().startsWith('|'));
  if (rows.length === 0) fail(`README.md "${HEADING}" section has no table`);
  return rows;
}

// 1 + 2: the compatibility table against the declared ranges.
const pairs = pairsFrom(compatibilityTable());
const rowed = new Set();

for (const { name, literal } of pairs) {
  const range = declaredRanges.get(name);
  if (range === undefined) {
    if (name.startsWith(SCOPE)) {
      fail(
        `README compatibility table lists ${name} \`${literal}\`, but package.json does not depend on it`,
      );
    }
    continue;
  }
  rowed.add(name);
  if (literalCovers(literal, range)) {
    checked.push(`${name} \`${literal}\` (package.json: ${range})`);
  } else {
    fail(
      `README compatibility table says ${name} \`${literal}\`, package.json declares ${range}`,
    );
  }
}

for (const name of libraries) {
  if (!rowed.has(name)) {
    fail(
      `README compatibility table has no row for ${name} (declared as ${declaredRanges.get(name)})`,
    );
  }
}

// 3 + 5: the roster count and the library names, wherever they are claimed.
const expectedWord = NUMBER_WORDS[libraries.length];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (haystack, needle) =>
  new RegExp(`(^|[^\\w/@-])${escape(needle)}([^\\w-]|$)`, 'i').test(haystack);

/** "all nine @nest-native libraries", "Nine libraries, nine chapters." */
const COUNT_CLAIM = /\b([a-z]+)[\s-]+(?:@?nest-native\s+)?(?:librar(?:y|ies)|chapters)\b/gi;

function checkRoster(label, text, { shortNames }) {
  if (expectedWord === undefined) return;

  if (mentions(text, expectedWord)) {
    checked.push(`${label} says "${expectedWord}"`);
  } else {
    fail(
      `${label} never says "${expectedWord}" — the app depends on ${libraries.length} ${SCOPE}* libraries`,
    );
  }

  // Every *counted* claim has to agree, not just one of them: a page can name
  // the new library in one paragraph and still say "eight" two paragraphs down.
  for (const [claim, word] of text.matchAll(COUNT_CLAIM)) {
    const lower = word.toLowerCase();
    if (NUMBER_WORDS.includes(lower) && lower !== expectedWord) {
      fail(
        `${label} claims "${claim.trim()}" — the app depends on ${libraries.length} ${SCOPE}* libraries`,
      );
    }
  }

  for (const name of libraries) {
    const claim = shortNames ? name.slice(SCOPE.length) : name;
    if (!text.includes(claim)) fail(`${label} does not name ${name}`);
  }
}

checkRoster('package.json description', pkg.description ?? '', {
  shortNames: true,
});
checkRoster('README.md', readme, { shortNames: false });
checkRoster('docs/index.html (the Pages site)', site, { shortNames: false });

// 4: the README's libraries-N/N badge counts the same roster.
const badge = /img\.shields\.io\/badge\/libraries-(\d+)%2F(\d+)/.exec(readme);
if (badge) {
  const [, covered, total] = badge;
  if (Number(covered) === libraries.length && Number(total) === libraries.length) {
    checked.push(`README libraries badge reads ${covered}/${total}`);
  } else {
    fail(
      `README libraries badge reads ${covered}/${total}, the app depends on ${libraries.length} ${SCOPE}* libraries`,
    );
  }
}

// Report.
if (problems.length === 0) {
  for (const line of checked) console.warn(`${LABEL}: ok   ${line}`);
  console.warn(
    `${LABEL}: ok — ${checked.length} claims verified across ${libraries.length} ${SCOPE}* libraries`,
  );
  process.exit(0);
}

for (const problem of problems) console.error(`${LABEL}: FAIL ${problem}`);
console.error(
  `${LABEL}: ${problems.length} problem(s). The roster changed — update README.md, package.json, docs/ and the repo About together (GUIDELINES_NEST_REFERENCE_APP.md).`,
);
process.exit(1);
