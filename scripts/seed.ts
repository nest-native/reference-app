import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config/env';
import {
  type Membership,
  type Organization,
  type Project,
  type User,
  memberships,
  organizations,
  projects,
  schema,
  users,
} from '../src/database/schema';

type AppDb = ReturnType<typeof drizzle<typeof schema>>;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureOrg(db: AppDb, slug: string, name: string): Organization {
  const existing = db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .get();
  if (existing) return existing;
  return db
    .insert(organizations)
    .values({ slug, name, createdAt: nowIso() })
    .returning()
    .get();
}

function ensureUser(db: AppDb, email: string, password: string): User {
  const existing = db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (existing) return existing;
  return db
    .insert(users)
    .values({
      email,
      passwordHash: hashPassword(password),
      createdAt: nowIso(),
    })
    .returning()
    .get();
}

function ensureMembership(
  db: AppDb,
  orgId: number,
  userId: number,
  role: 'admin' | 'member' | 'viewer',
): Membership {
  const existing = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .get();
  if (existing) return existing;
  return db
    .insert(memberships)
    .values({ orgId, userId, role, createdAt: nowIso() })
    .returning()
    .get();
}

function ensureProject(
  db: AppDb,
  orgId: number,
  name: string,
  createdBy: number,
): Project {
  const existing = db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.name, name)))
    .get();
  if (existing) return existing;
  return db
    .insert(projects)
    .values({ orgId, name, createdBy, createdAt: nowIso() })
    .returning()
    .get();
}

export interface SeedResult {
  org: Organization;
  admin: User;
  membership: Membership;
  project: Project;
}

export function seedDatabase(databaseUrl: string): SeedResult {
  const sqlite = new Database(databaseUrl);
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder: './src/database/migrations' });

  const org = ensureOrg(db, 'acme', 'Acme Corp');
  const admin = ensureUser(db, 'admin@acme.test', 'admin123!');
  const membership = ensureMembership(db, org.id, admin.id, 'admin');
  const project = ensureProject(db, org.id, 'Starter Project', admin.id);

  sqlite.close();
  return { org, admin, membership, project };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { org, admin, membership, project } = seedDatabase(env.databaseUrl);

  console.warn(`Seeded into ${env.databaseUrl}:`);
  console.warn(`  org #${org.id} (${org.slug})`);
  console.warn(`  user #${admin.id} (${admin.email})`);
  console.warn(`  membership #${membership.id} (${membership.role})`);
  console.warn(`  project #${project.id} (${project.name})`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
