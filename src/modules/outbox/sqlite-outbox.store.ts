import type { Provider } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import {
  type OutboxClaimRequest,
  type OutboxDeadLetter,
  type OutboxDeadLetterFilter,
  type OutboxDeadLetterQuery,
  type OutboxDeadLetterUpdate,
  type OutboxInboxStore,
  type OutboxMessage,
  type OutboxRescheduleUpdate,
  OutboxStorage,
  type OutboxStore,
  type OutboxStoreStats,
  OutboxTransactionRequiredError,
} from '@nestjs/outbox';
import { and, asc, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../../database/database';
import {
  type OutboxDeadLetterRow,
  type OutboxMessageRow,
  outboxDeadLetters,
  outboxInbox,
  outboxMessages,
} from '../../database/schema';

const MESSAGE_FIELDS = {
  id: outboxMessages.id,
  topic: outboxMessages.topic,
  payload: outboxMessages.payload,
  headers: outboxMessages.headers,
  key: outboxMessages.key,
  createdAt: outboxMessages.createdAt,
  availableAt: outboxMessages.availableAt,
  attempts: outboxMessages.attempts,
  lastError: outboxMessages.lastError,
};

const DEAD_LETTER_FIELDS = {
  id: outboxDeadLetters.id,
  topic: outboxDeadLetters.topic,
  payload: outboxDeadLetters.payload,
  headers: outboxDeadLetters.headers,
  key: outboxDeadLetters.key,
  createdAt: outboxDeadLetters.createdAt,
  attempts: outboxDeadLetters.attempts,
  lastError: outboxDeadLetters.lastError,
  history: outboxDeadLetters.history,
  reason: outboxDeadLetters.reason,
  failedAt: outboxDeadLetters.failedAt,
};

/**
 * A statement binds at most 32,766 variables (better-sqlite3's SQLite), and a
 * message row takes 9. A larger batch, or a longer list of ids, takes several
 * statements in one transaction, as in the module's MySQL store.
 */
const MESSAGES_PER_INSERT = 1_000;
const IDS_PER_STATEMENT = 1_000;

/** The database itself, as `drizzle()` returns it: with its better-sqlite3 connection. */
export type SqliteDatabase = AppDatabase & { $client: Database.Database };

/** Exactly the columns an `OutboxMessage` and an `OutboxDeadLetter` are made of. */
type MessageRow = Pick<OutboxMessageRow, keyof typeof MESSAGE_FIELDS>;
type DeadLetterRow = Pick<OutboxDeadLetterRow, keyof typeof DEAD_LETTER_FIELDS>;

/**
 * The official outbox's store on the app's SQLite database: both of
 * `@nestjs/outbox`'s storage contracts, `OutboxStore` (the messages and the
 * dead letters) and `OutboxInboxStore` (the consumers' inbox). The package
 * ships stores for PostgreSQL and MySQL only; this is the public extension
 * point it documents for any other database, and
 * `test/integration/sqlite-outbox-store.contract.spec.ts` runs the package's
 * own contract suites against it.
 *
 * Every method is synchronous, like better-sqlite3 itself. That is what keeps
 * `Outbox.add()` and `OutboxInbox.processInTransaction()` synchronous inside
 * the app's synchronous `@Transactional()` bodies.
 *
 * Commit order needs no lock per key here: SQLite has a single writer, and the
 * write lock a transaction takes at its first write is held until it commits,
 * so `seq` (assigned at insert) numbers the messages in commit order, across
 * the API and the worker processes alike. The store's own multi-statement
 * transactions open with BEGIN IMMEDIATE, taking the lock before they read: a
 * deferred one that read first would fail at once with SQLITE_BUSY_SNAPSHOT
 * when the other process committed in between, instead of waiting for the
 * lock.
 */
export class SqliteOutboxStore
  implements OutboxStore<AppDatabase>, OutboxInboxStore<AppDatabase>
{
  private readonly sqlite: Database.Database;

  constructor(
    private readonly db: SqliteDatabase,
    storage?: OutboxStorage,
  ) {
    this.sqlite = db.$client;
    storage?.registerSource({ messages: this, inbox: this });
  }

  add(tx: AppDatabase, messages: readonly OutboxMessage[]): void {
    this.requireTransaction(tx, 'add');
    // In the batch's order, chunk after chunk, so seq follows it.
    for (const chunk of chunks(messages, MESSAGES_PER_INSERT)) {
      tx.insert(outboxMessages)
        .values(
          chunk.map((message) => ({
            id: message.id,
            topic: message.topic,
            payload: toJson(message.payload),
            headers: JSON.stringify(message.headers),
            key: message.key,
            createdAt: epochMs(message.createdAt),
            availableAt: epochMs(message.availableAt),
          })),
        )
        .run();
    }
  }

  claim({ owner, now, leaseMs, limit }: OutboxClaimRequest): OutboxMessage[] {
    return this.db.transaction(
      (tx) => {
        const due = tx.all<{ seq: number }>(
          sql`SELECT m.seq FROM outbox_messages m WHERE ${claimable(now)} ORDER BY m.seq LIMIT ${limit}`,
        );
        if (due.length === 0) {
          return [];
        }
        const seqs = due.map((row) => row.seq);
        tx.update(outboxMessages)
          .set({ leaseOwner: owner, leaseUntil: epochMs(now + leaseMs) })
          .where(inArray(outboxMessages.seq, seqs))
          .run();
        return tx
          .select(MESSAGE_FIELDS)
          .from(outboxMessages)
          .where(inArray(outboxMessages.seq, seqs))
          .orderBy(asc(outboxMessages.seq))
          .all()
          .map(toMessage);
      },
      { behavior: 'immediate' },
    );
  }

  markPublished(id: string, owner: string): boolean {
    return (
      this.db
        .delete(outboxMessages)
        .where(leasedBy(id, owner))
        .run().changes === 1
    );
  }

  reschedule(id: string, owner: string, update: OutboxRescheduleUpdate): boolean {
    // The failure joins the history in the same statement that checks the lease.
    return (
      this.db
        .update(outboxMessages)
        .set({
          attempts: update.attempts,
          availableAt: epochMs(update.availableAt),
          lastError: update.error.error,
          history: sql`json_insert(history, '$[#]', json(${JSON.stringify(update.error)}))`,
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(leasedBy(id, owner))
        .run().changes === 1
    );
  }

  deadLetter(id: string, owner: string, update: OutboxDeadLetterUpdate): boolean {
    // Copied with its seq, so a requeue puts it back at its place in its key,
    // and over an earlier dead letter with the same id. Both writes are fenced
    // by the lease, so the message moves or stays, never both.
    return this.db.transaction(
      (tx) => {
        tx.run(sql`INSERT INTO outbox_dead_letters
            (id, seq, topic, payload, headers, key, created_at, attempts, last_error, history, reason, failed_at)
          SELECT id, seq, topic, payload, headers, key, created_at, ${update.attempts}, ${update.error.error},
            json_insert(history, '$[#]', json(${JSON.stringify(update.error)})), ${update.reason}, ${epochMs(update.failedAt)}
          FROM outbox_messages WHERE id = ${id} AND lease_owner = ${owner}
          ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, topic = excluded.topic,
            payload = excluded.payload, headers = excluded.headers, key = excluded.key,
            created_at = excluded.created_at, attempts = excluded.attempts,
            last_error = excluded.last_error, history = excluded.history,
            reason = excluded.reason, failed_at = excluded.failed_at`);
        return (
          tx.delete(outboxMessages).where(leasedBy(id, owner)).run().changes ===
          1
        );
      },
      { behavior: 'immediate' },
    );
  }

  release(ids: readonly string[], owner: string): number {
    if (ids.length === 0) {
      return 0;
    }
    return this.db.transaction(
      (tx) => {
        let released = 0;
        for (const chunk of chunks(ids, IDS_PER_STATEMENT)) {
          released += tx
            .update(outboxMessages)
            .set({ leaseOwner: null, leaseUntil: null })
            .where(
              and(
                eq(outboxMessages.leaseOwner, owner),
                inArray(outboxMessages.id, chunk),
              ),
            )
            .run().changes;
        }
        return released;
      },
      { behavior: 'immediate' },
    );
  }

  stats(now: number): OutboxStoreStats {
    // One statement, so every count comes from the same snapshot.
    const row = this.db.get<{
      pending: number;
      ready: number;
      leased: number;
      dead_letters: number;
      oldest_due_at: number | null;
    }>(sql`SELECT
      (SELECT count(*) FROM outbox_messages) AS pending,
      (SELECT count(*) FROM outbox_messages m WHERE ${claimable(now)}) AS ready,
      (SELECT count(*) FROM outbox_messages WHERE lease_until > ${now}) AS leased,
      (SELECT count(*) FROM outbox_dead_letters) AS dead_letters,
      (SELECT min(CASE WHEN attempts > 0 THEN created_at WHEN available_at <= ${now} THEN available_at END)
        FROM outbox_messages) AS oldest_due_at`);
    return {
      pending: row.pending,
      ready: row.ready,
      leased: row.leased,
      deadLetters: row.dead_letters,
      oldestDueAt: row.oldest_due_at,
    };
  }

  listDeadLetters(query: OutboxDeadLetterQuery): OutboxDeadLetter[] {
    const { limit, offset } = deadLetterPage(query);
    return this.db
      .select(DEAD_LETTER_FIELDS)
      .from(outboxDeadLetters)
      .where(
        and(
          query.topic === undefined
            ? undefined
            : eq(outboxDeadLetters.topic, query.topic),
          query.key === undefined
            ? undefined
            : eq(outboxDeadLetters.key, query.key),
        ),
      )
      .orderBy(desc(outboxDeadLetters.failedAt), desc(outboxDeadLetters.id))
      .limit(limit)
      .offset(offset)
      .all()
      .map(toDeadLetter);
  }

  getDeadLetter(id: string): OutboxDeadLetter | undefined {
    const row = this.db
      .select(DEAD_LETTER_FIELDS)
      .from(outboxDeadLetters)
      .where(eq(outboxDeadLetters.id, id))
      .get();
    return row && toDeadLetter(row);
  }

  requeueDeadLetters(filter: OutboxDeadLetterFilter, now: number): number {
    const wheres = deadLetterWheres(filter);
    if (wheres.length === 0) {
      return 0;
    }
    return this.db.transaction(
      (tx) => {
        let requeued = 0;
        for (const where of wheres) {
          const clash = tx
            .select({ id: outboxDeadLetters.id })
            .from(outboxDeadLetters)
            .innerJoin(outboxMessages, eq(outboxMessages.id, outboxDeadLetters.id))
            .where(where)
            .limit(1)
            .get();
          if (clash) {
            throw new Error(
              `Can't requeue dead letter "${clash.id}": a message with that id is pending`,
            );
          }
          // Back with its id and its seq, a fresh budget and its history.
          requeued += tx.run(sql`INSERT INTO outbox_messages
              (seq, id, topic, payload, headers, key, created_at, available_at, attempts, last_error, history)
            SELECT seq, id, topic, payload, headers, key, created_at, ${epochMs(now)}, 0, last_error, history
            FROM outbox_dead_letters WHERE ${where}`).changes;
          tx.delete(outboxDeadLetters).where(where).run();
        }
        return requeued;
      },
      { behavior: 'immediate' },
    );
  }

  purgeDeadLetters(filter: OutboxDeadLetterFilter): number {
    const wheres = deadLetterWheres(filter);
    if (wheres.length === 0) {
      return 0;
    }
    return this.db.transaction(
      (tx) => {
        let purged = 0;
        for (const where of wheres) {
          purged += tx.delete(outboxDeadLetters).where(where).run().changes;
        }
        return purged;
      },
      { behavior: 'immediate' },
    );
  }

  recordInbox(
    tx: AppDatabase | undefined,
    consumer: string,
    messageId: string,
    now: number,
  ): boolean {
    const db = tx === undefined ? this.db : this.requireTransaction(tx, 'recordInbox');
    return (
      db
        .insert(outboxInbox)
        .values({ consumer, messageId, processedAt: epochMs(now) })
        .onConflictDoNothing({
          target: [outboxInbox.consumer, outboxInbox.messageId],
        })
        .run().changes === 1
    );
  }

  hasInbox(consumer: string, messageId: string): boolean {
    const row = this.db
      .select({ consumer: outboxInbox.consumer })
      .from(outboxInbox)
      .where(
        and(
          eq(outboxInbox.consumer, consumer),
          eq(outboxInbox.messageId, messageId),
        ),
      )
      .get();
    return row !== undefined;
  }

  pruneInbox(before: number): number {
    return this.db
      .delete(outboxInbox)
      .where(lt(outboxInbox.processedAt, Math.ceil(before)))
      .run().changes;
  }

  // better-sqlite3 has one connection, and a write through any handle joins
  // the transaction open on it. The handle cannot tell: the @InjectTransaction()
  // proxy wraps the database object itself. So the connection decides, and the
  // database outside a transaction is refused like any non-transaction.
  private requireTransaction(
    tx: AppDatabase | null | undefined,
    method: string,
  ): AppDatabase {
    if (tx === undefined || tx === null || !this.sqlite.inTransaction) {
      throw new OutboxTransactionRequiredError(
        `SqliteOutboxStore.${method}(): no transaction is open on the database.`,
      );
    }
    return tx;
  }
}

/** Registers the store with the outbox: Nest builds it once, before OutboxModule locks its storage. */
export const sqliteOutboxStoreProvider: Provider = {
  provide: SqliteOutboxStore,
  inject: [getDrizzleToken(), OutboxStorage],
  useFactory: (db: SqliteDatabase, storage: OutboxStorage) =>
    new SqliteOutboxStore(db, storage),
};

// Due, unleased (or its lease ran out), and no older message of its key is
// delayed or leased: what a claim may take, and what stats() counts as ready.
function claimable(now: number): SQL {
  return sql`m.available_at <= ${now} AND (m.lease_until IS NULL OR m.lease_until <= ${now})
    AND (m.key IS NULL OR NOT EXISTS (
      SELECT 1 FROM outbox_messages older
      WHERE older.key = m.key AND older.seq < m.seq
        AND (older.available_at > ${now} OR older.lease_until > ${now})))`;
}

function leasedBy(id: string, owner: string): SQL | undefined {
  return and(eq(outboxMessages.id, id), eq(outboxMessages.leaseOwner, owner));
}

/**
 * The dead letters a filter selects, as one condition per statement: one for
 * each chunk of its `ids`, or a single one, and none for a filter that selects
 * nothing (`ids: []`). The fields combine with AND, and an empty filter is
 * refused unless it says `all`.
 */
function deadLetterWheres(filter: OutboxDeadLetterFilter): SQL[] {
  const { ids, topic, key, failedBefore, all } = filter;
  if (
    !all &&
    ids === undefined &&
    topic === undefined &&
    key === undefined &&
    failedBefore === undefined
  ) {
    throw new Error('Refusing an empty dead-letter filter; pass { all: true }');
  }
  const conditions: SQL[] = [];
  if (topic !== undefined) conditions.push(eq(outboxDeadLetters.topic, topic));
  if (key !== undefined) conditions.push(eq(outboxDeadLetters.key, key));
  if (failedBefore !== undefined) {
    const before = Number(failedBefore);
    if (!Number.isFinite(before)) {
      throw new TypeError(
        `Dead-letter filter: \`failedBefore\` must be a valid Date or epoch milliseconds (got ${String(failedBefore)})`,
      );
    }
    // `failed_at < 1.5` over whole milliseconds is `failed_at < 2`.
    conditions.push(lt(outboxDeadLetters.failedAt, Math.ceil(before)));
  }
  if (ids === undefined) {
    return [and(...conditions) ?? sql`true`];
  }
  return chunks(ids, IDS_PER_STATEMENT).map(
    (chunk) => and(inArray(outboxDeadLetters.id, chunk), ...conditions) as SQL,
  );
}

/** `values` in consecutive slices of at most `size`. */
function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function deadLetterPage({ limit = 50, offset = 0 }: OutboxDeadLetterQuery): {
  limit: number;
  offset: number;
} {
  for (const [name, value] of [
    ['limit', limit],
    ['offset', offset],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `listDeadLetters(): \`${name}\` must be a whole number of at least 0 (got ${String(value)})`,
      );
    }
  }
  return { limit, offset };
}

/** Epoch ms as the integer columns keep them: a numeric delay or lease can have a fraction. */
function epochMs(value: number): number {
  return Math.floor(value);
}

/** A null payload is SQL NULL, any other JSON value its text. */
function toJson(payload: unknown): string | null {
  return payload === null ? null : JSON.stringify(payload);
}

function fromJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function toMessage(row: MessageRow): OutboxMessage {
  return {
    ...row,
    payload: fromJson(row.payload),
    headers: JSON.parse(row.headers),
  };
}

function toDeadLetter(row: DeadLetterRow): OutboxDeadLetter {
  return {
    ...row,
    payload: fromJson(row.payload),
    headers: JSON.parse(row.headers),
    history: JSON.parse(row.history),
  };
}
