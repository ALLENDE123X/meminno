import { defineConfig } from 'drizzle-kit'
import { config } from 'dotenv'

config({ path: '.env.local' })

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // MIGRATION_DATABASE_URL is the table-OWNING `meminno_app` role; plain
    // DATABASE_URL is the app's runtime `meminno_rls` role, which owns
    // nothing and cannot run DDL at all (MEM-002-fix, issue #14 - see
    // lib/db/schema.ts's header comment). The fallback exists only for
    // single-role environments (a throwaway local Postgres); against the
    // real project MIGRATION_DATABASE_URL must be set, or `drizzle-kit
    // migrate` fails on the first CREATE with a permission error.
    url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '',
  },
  schemaFilter: ['public'],
})
