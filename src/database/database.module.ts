import { Module } from '@nestjs/common';
import { DrizzleModule } from '@nestjs/drizzle';
import { loadEnv } from '../config/env';
import { createDatabase } from './database';

const env = loadEnv();
const handle = createDatabase(env.databaseUrl);

// The official module registers the database globally under
// `getDrizzleToken()`, which is also the token the libraries are handed
// (`drizzleInstanceToken`), and closes its better-sqlite3 client
// (`db.$client`) when the application shuts down.
@Module({
  imports: [DrizzleModule.forRoot({ db: handle.db })],
})
export class DatabaseModule {}
