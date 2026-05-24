import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  auditEvents,
  memberships,
  organizations,
  outboxEvents,
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

test('outbox_events: defaults attempts/maxAttempts and round-trips payload', () => {
  const payload = { topic: 'user.invited', email: 'invitee@example.test' };
  const [event] = db
    .insert(outboxEvents)
    .values({
      id: randomUUID(),
      topic: 'user.invited',
      payload,
      status: 'pending',
      availableAt: nowIso(),
      createdAt: nowIso(),
    })
    .returning()
    .all();

  assert.equal(event.status, 'pending');
  assert.equal(event.attempts, 0);
  assert.equal(event.maxAttempts, 10);
  assert.deepEqual(event.payload, payload);
});

test('outbox_events: idempotency_key is unique when set, multiple NULLs allowed', () => {
  db.insert(outboxEvents)
    .values({
      id: randomUUID(),
      topic: 'noop',
      payload: {},
      status: 'pending',
      availableAt: nowIso(),
      createdAt: nowIso(),
    })
    .run();
  db.insert(outboxEvents)
    .values({
      id: randomUUID(),
      topic: 'noop',
      payload: {},
      status: 'pending',
      availableAt: nowIso(),
      createdAt: nowIso(),
    })
    .run();

  const idemKey = 'idem-abc';
  db.insert(outboxEvents)
    .values({
      id: randomUUID(),
      topic: 'user.invited',
      payload: {},
      status: 'pending',
      idempotencyKey: idemKey,
      availableAt: nowIso(),
      createdAt: nowIso(),
    })
    .run();

  assert.throws(() =>
    db
      .insert(outboxEvents)
      .values({
        id: randomUUID(),
        topic: 'user.invited',
        payload: {},
        status: 'pending',
        idempotencyKey: idemKey,
        availableAt: nowIso(),
        createdAt: nowIso(),
      })
      .run(),
  );

  const withKey = db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.idempotencyKey, idemKey))
    .all();
  assert.equal(withKey.length, 1);
});
