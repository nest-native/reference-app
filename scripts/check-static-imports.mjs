#!/usr/bin/env node
/**
 * One-copy gate for the NestJS and CLS packages.
 *
 * Under `node --import tsx`, an `import()` of an ESM-only package does not
 * return the instance `src/` gets from its compiled `require()`: tsx loads a
 * second copy. The CLS packages ship separate ESM and CommonJS builds, which
 * splits them the same way. `@nestjs/*` (core and common are ESM-only since
 * NestJS 12, like outbox and drizzle) and the CLS packages define the classes
 * Nest resolves providers by, so a second copy fails at boot with "Nest can't
 * resolve dependencies of ..." for a token that is plainly registered. That
 * has happened three times here: with nestjs-cls, with @nestjs/outbox, and
 * with @nestjs/core on NestJS 12 (HttpAdapterHost in ClsRootModule).
 *
 * NestJS 12 makes such an `import()` itself: given no HTTP adapter,
 * `NestFactory.create()` loads `@nestjs/platform-express` with `import()`,
 * and with it a second `@nestjs/common`. That adapter wraps body-parser errors
 * in the second copy's `HttpException`, which the exception filter does not
 * recognise, so a body-parser 4xx (400, 413, 415) is answered 500.
 *
 * This script fails, in src/, test/, scripts/ and client-smoke/, on:
 * - any `import()` whose specifier starts with `@nestjs/` or `@nestjs-cls/`,
 *   or is `nestjs-cls`. Import those packages statically; keep `import()` for
 *   our own modules that read the environment when they load.
 * - any `NestFactory.create()` call whose second argument is neither a
 *   `new ...Adapter(` expression nor an identifier (taken to hold one). Pass
 *   `new ExpressAdapter()`, imported statically. `undefined` and `null` do not
 *   count as an adapter. `createApplicationContext()` and
 *   `createMicroservice()` take no HTTP adapter and are not checked. A match
 *   preceded on its line by `//`, `/*` or a leading `*` is taken for a comment.
 *
 * Wired into `npm run lint`. Exits non-zero with one line per offending call.
 *
 * Usage: node scripts/check-static-imports.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCANNED = ['src', 'test', 'scripts', 'client-smoke'];
const EXTENSIONS = /\.(?:[cm]?ts|[cm]?js)$/;
const DYNAMIC_IMPORT =
  /\bimport\(\s*(['"`])((?:@nestjs\/|@nestjs-cls\/)[^'"`]+|nestjs-cls(?:\/[^'"`]+)?)\1/g;
// `create(` or `create<...>(`, so never `createApplicationContext(` or `createMicroservice(`.
const NEST_FACTORY_CREATE = /\bNestFactory\s*\.\s*create\s*(?:<[^()]*?>\s*)?\(/g;
const ADAPTER_ARGUMENT = /^(?:new\s+[\w$.]*Adapter\s*\(|(?!(?:undefined|null)$)[A-Za-z_$][\w$]*$)/;
// Text before a match on its line that makes the match prose: `//`, `/*`, or a leading `*`.
const COMMENT_BEFORE = /\/\/|\/\*|^\s*\*/;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (EXTENSIONS.test(entry.name)) yield path;
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** The top-level arguments of the call whose opening parenthesis ends at `start`. */
function callArguments(text, start) {
  const args = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      if (depth === 0) return [...args, text.slice(from, i).trim()];
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return args;
}

const problems = [];
for (const dir of SCANNED) {
  for (const file of sourceFiles(join(root, dir))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(DYNAMIC_IMPORT)) {
      problems.push(`${relative(root, file)}:${lineOf(text, match.index)}: import('${match[2]}') loads a second copy under tsx; import it statically`);
    }
    for (const match of text.matchAll(NEST_FACTORY_CREATE)) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      if (COMMENT_BEFORE.test(text.slice(lineStart, match.index))) continue;
      const [, raw = ''] = callArguments(text, match.index + match[0].length);
      const adapter = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
      if (!ADAPTER_ARGUMENT.test(adapter)) {
        problems.push(`${relative(root, file)}:${lineOf(text, match.index)}: NestFactory.create without an HTTP adapter makes NestJS 12 import() @nestjs/platform-express, a second @nestjs/common under tsx; pass new ExpressAdapter()`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-static-imports: no import() of @nestjs/*, @nestjs-cls/* or nestjs-cls, and every NestFactory.create passes an HTTP adapter');
