import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { organizations, schema } from '../../src/database/schema';

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-test-orgs-${process.pid}-${Date.now()}.db`,
);

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  sqlite = new Database(dbPath);
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
});

after(() => {
  sqlite.close();
});

test('organizations table is queryable after migration', () => {
  const rows = db.select().from(organizations).all();
  assert.deepEqual(rows, []);
});

test('organizations table accepts an insert and enforces unique slug', () => {
  const created = db
    .insert(organizations)
    .values({
      slug: 'first-org',
      name: 'First Org',
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all();

  assert.equal(created.length, 1);
  assert.equal(created[0]?.slug, 'first-org');

  assert.throws(() =>
    db
      .insert(organizations)
      .values({
        slug: 'first-org',
        name: 'Duplicate',
        createdAt: new Date().toISOString(),
      })
      .run(),
  );
});
