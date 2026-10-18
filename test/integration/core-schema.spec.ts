import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  auditEvents,
  memberships,
  organizations,
  projects,
  schema,
  users,
} from '../../src/database/schema';

const dbPath = join(
  tmpdir(),
  `nest-native-reference-app-test-coreschema-${process.pid}-${Date.now()}.db`,
);

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const nowIso = () => new Date().toISOString();

before(() => {
  sqlite = new Database(dbPath);
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './src/database/migrations' });
});

after(() => {
  sqlite.close();
});

test('users: enforces unique email', () => {
  db.insert(users)
    .values({
      email: 'one@example.test',
      passwordHash: 'placeholder',
      createdAt: nowIso(),
    })
    .run();

  assert.throws(() =>
    db
      .insert(users)
      .values({
        email: 'one@example.test',
        passwordHash: 'placeholder',
        createdAt: nowIso(),
      })
      .run(),
  );
});

test('memberships: enforces unique (org_id, user_id) and rejects orphan FKs', () => {
  const [org] = db
    .insert(organizations)
    .values({ slug: 'mem-org', name: 'Mem Org', createdAt: nowIso() })
    .returning()
    .all();
  const [user] = db
    .insert(users)
    .values({
      email: 'mem@example.test',
      passwordHash: 'placeholder',
      createdAt: nowIso(),
    })
    .returning()
    .all();

  db.insert(memberships)
    .values({ orgId: org.id, userId: user.id, role: 'admin', createdAt: nowIso() })
    .run();

  assert.throws(() =>
    db
      .insert(memberships)
      .values({
        orgId: org.id,
        userId: user.id,
        role: 'member',
        createdAt: nowIso(),
      })
      .run(),
  );

  assert.throws(() =>
    db
      .insert(memberships)
      .values({
        orgId: 99999,
        userId: user.id,
        role: 'member',
        createdAt: nowIso(),
      })
      .run(),
  );
});

test('projects: requires valid org and creator', () => {
  const [org] = db
    .insert(organizations)
    .values({ slug: 'proj-org', name: 'Proj Org', createdAt: nowIso() })
    .returning()
    .all();
  const [creator] = db
    .insert(users)
    .values({
      email: 'creator@example.test',
      passwordHash: 'placeholder',
      createdAt: nowIso(),
    })
    .returning()
    .all();

  const [project] = db
    .insert(projects)
    .values({
      orgId: org.id,
      name: 'First Project',
      createdBy: creator.id,
      createdAt: nowIso(),
    })
    .returning()
    .all();

  assert.equal(project.orgId, org.id);
  assert.equal(project.createdBy, creator.id);

  assert.throws(() =>
    db
      .insert(projects)
      .values({
        orgId: 99999,
        name: 'Orphan',
        createdBy: creator.id,
        createdAt: nowIso(),
      })
      .run(),
  );
});

test('audit_events: stores JSON metadata and round-trips it', () => {
  const [org] = db
    .insert(organizations)
    .values({ slug: 'audit-org', name: 'Audit Org', createdAt: nowIso() })
    .returning()
    .all();
  const [actor] = db
    .insert(users)
    .values({
      email: 'actor@example.test',
      passwordHash: 'placeholder',
      createdAt: nowIso(),
    })
    .returning()
    .all();

  const metadata = { invitedEmail: 'invitee@example.test', source: 'test' };
  const [event] = db
    .insert(auditEvents)
    .values({
      orgId: org.id,
      actorUserId: actor.id,
      action: 'user.invited',
      subjectType: 'user',
      subjectId: 'invitee@example.test',
      metadata,
      createdAt: nowIso(),
    })
    .returning()
    .all();

  assert.deepEqual(event.metadata, metadata);
});
