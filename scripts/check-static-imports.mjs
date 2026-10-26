#!/usr/bin/env node
/**
 * One-copy gate for the packages that define injection tokens.
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
 * This script fails on any `import()` whose specifier starts with `@nestjs/`
 * or `@nestjs-cls/`, or is `nestjs-cls`, in src/, test/ and scripts/. Import
 * those packages statically; keep `import()` for our own modules that read
 * the environment when they load.
 *
 * Wired into `npm run lint`. Exits non-zero with one line per offending call.
 *
 * Usage: node scripts/check-static-imports.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCANNED = ['src', 'test', 'scripts'];
const EXTENSIONS = /\.(?:[cm]?ts|[cm]?js)$/;
const DYNAMIC_IMPORT =
  /\bimport\(\s*(['"`])((?:@nestjs\/|@nestjs-cls\/)[^'"`]+|nestjs-cls(?:\/[^'"`]+)?)\1/g;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (EXTENSIONS.test(entry.name)) yield path;
  }
}

const problems = [];
for (const dir of SCANNED) {
  for (const file of sourceFiles(join(root, dir))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(DYNAMIC_IMPORT)) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(`${relative(root, file)}:${line}: import('${match[2]}') loads a second copy under tsx; import it statically`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-static-imports: no import() of @nestjs/*, @nestjs-cls/* or nestjs-cls');
