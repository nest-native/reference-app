import type { TransactionalAdapter } from '@nestjs-cls/transactional';
import type { AppDatabase } from './database';

// The official @nestjs-cls/transactional-adapter-drizzle-orm wraps the
// drizzle transaction callback in an `async` function. That works for
// async drivers (libsql, postgres) but silently breaks better-sqlite3:
// the SQLite native transaction is synchronous, sees the async callback
// return a Promise immediately, commits an empty tx, and the inner work
// runs *after* commit (against a closed tx).
//
// This adapter keeps the inner callback synchronous, which is the only
// shape better-sqlite3 actually honors. It still returns a Promise from
// wrapWithTransaction to satisfy the plugin contract.
export class SyncDrizzleTransactionalAdapter
  implements TransactionalAdapter<AppDatabase, AppDatabase, never>
{
  public readonly connectionToken: string;
  public readonly defaultTxOptions: never | undefined;
  public readonly supportsTransactionProxy = true;

  constructor(options: { drizzleInstanceToken: string }) {
    this.connectionToken = options.drizzleInstanceToken;
  }

  optionsFactory = (drizzleInstance: AppDatabase) => ({
    wrapWithTransaction: async <T>(
      _options: never | undefined,
      fn: () => Promise<T> | T,
      setClient: (client?: AppDatabase) => void,
    ): Promise<T> => {
      return drizzleInstance.transaction((tx) => {
        setClient(tx as unknown as AppDatabase);
        const result = fn();
        if (result instanceof Promise) {
          throw new Error(
            'SyncDrizzleTransactionalAdapter: @Transactional methods must be synchronous when using better-sqlite3',
          );
        }
        return result;
      }) as T;
    },
    getFallbackInstance: () => drizzleInstance,
  });
}
