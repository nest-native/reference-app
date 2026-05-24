import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  memberships,
  organizations,
  projects,
  schema,
  users,
} from '../../src/database/schema';
import { seedDatabase } from '../../scripts/seed';

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-test-seed-${process.pid}-${Date.now()}.db`,
);

let inspector: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  inspector = new Database(dbPath);
  db = drizzle(inspector, { schema });
});

after(() => {
  inspector.close();
});

test('seed produces one of each entity on first run', () => {
  const result = seedDatabase(dbPath);

  assert.equal(result.org.slug, 'acme');
  assert.equal(result.admin.email, 'admin@acme.test');
  assert.equal(result.membership.role, 'admin');
  assert.equal(result.project.name, 'Starter Project');

  assert.equal(db.select().from(organizations).all().length, 1);
  assert.equal(db.select().from(users).all().length, 1);
  assert.equal(db.select().from(memberships).all().length, 1);
  assert.equal(db.select().from(projects).all().length, 1);
});

test('seed is idempotent on second run', () => {
  const first = seedDatabase(dbPath);
  const second = seedDatabase(dbPath);

  assert.equal(first.org.id, second.org.id);
  assert.equal(first.admin.id, second.admin.id);
  assert.equal(first.membership.id, second.membership.id);
  assert.equal(first.project.id, second.project.id);

  assert.equal(db.select().from(organizations).all().length, 1);
  assert.equal(db.select().from(users).all().length, 1);
  assert.equal(db.select().from(memberships).all().length, 1);
  assert.equal(db.select().from(projects).all().length, 1);
});

test('seeded user password_hash uses scrypt format', () => {
  const result = seedDatabase(dbPath);
  assert.match(result.admin.passwordHash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});
