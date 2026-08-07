import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// max: 1 + a short idle_timeout is the standard postgres.js configuration
// for a serverless target sitting behind Supabase's transaction-mode pooler
// (port 6543, PgBouncer/Supavisor). Every Vercel/Inngest invocation gets its
// own fresh module scope and therefore its own postgres() client - with no
// cap, each client defaults to up to 10 connections, so a handful of
// concurrent invocations can exhaust the pooler's shared connection slots. A
// single serverless invocation only ever needs one connection at a time
// (queries within it are sequential), so max: 1 costs nothing and lets far
// more concurrent invocations succeed within the pooler's real capacity.
// idle_timeout releases that one connection back to the pooler quickly once
// a request finishes, rather than holding it for a container's whole
// (possibly long) idle-then-reused lifetime.
//
// Mirrors Propinno's lib/db/index.ts verbatim (same pooling rationale, same
// lazy-Proxy fallback so static analysis/build doesn't crash when
// DATABASE_URL is absent).
const POOL_OPTIONS = { prepare: false, max: 1, idle_timeout: 20 } as const

let db: PostgresJsDatabase<typeof schema>

if (process.env.DATABASE_URL) {
  const client = postgres(process.env.DATABASE_URL, POOL_OPTIONS)
  db = drizzle(client, { schema })
} else {
  // Create a dummy client and database instance to act as the Proxy target.
  // This ensures prototype checks (like Drizzle's `is(db, PgDatabase)`) succeed during static compilation
  // and do not throw "Unsupported database type" errors in adapter initializations like NextAuth.
  const dummyClient = postgres('postgresql://localhost:5432/postgres', POOL_OPTIONS)
  const dummyDb = drizzle(dummyClient, { schema })

  // Use Proxy to handle database operations lazily when DATABASE_URL is available
  db = new Proxy(dummyDb, {
    get(target, prop) {
      // Delegate symbols, constructor, and then-able checks to the dummy database to avoid crashing
      // during library initialization and static analysis when DATABASE_URL is absent.
      if (
        !process.env.DATABASE_URL &&
        (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then')
      ) {
        return Reflect.get(target, prop)
      }

      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is missing from environment variables. Cannot execute database operations.')
      }
      const client = postgres(process.env.DATABASE_URL, POOL_OPTIONS)
      const actualDb = drizzle(client, { schema })
      return Reflect.get(actualDb, prop)
    }
  }) as PostgresJsDatabase<typeof schema>
}

export { db }
export type DbType = typeof db
