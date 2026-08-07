import { describe, it, expect } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  users,
  documents,
  notes,
  flashcards,
  quizzes,
  quizAttempts,
  healthChecks,
} from '@/lib/db/schema'

// Static schema-shape assertions - no DB connection needed, always runs (no
// DATABASE_URL gating), unlike tests/integration/rls.test.ts which needs a
// real Postgres connection to prove the policies actually enforce anything.
// This file's job is narrower but cheaper: catch an accidentally-missing
// `.enableRLS()` or `pgPolicy(...)` before it ever reaches a real database.
describe('schema RLS wiring (lib/db/schema.ts)', () => {
  const userTables = { users, documents, notes, flashcards, quizzes, quizAttempts }

  it.each(Object.entries(userTables))('%s has RLS enabled with exactly one authenticated-scoped policy', (_name, table) => {
    const config = getTableConfig(table)
    expect(config.enableRLS).toBe(true)
    expect(config.policies).toHaveLength(1)
    expect(config.policies[0].for).toBe('all')
    expect(config.policies[0].to).toBe('authenticated')
    // Every policy must scope by identity (auth.uid()), not leave using/
    // withCheck unset (an unset `using` on a permissive policy defaults to
    // allowing everything - the one mistake that would make a policy
    // present but silently do nothing).
    expect(config.policies[0].using).toBeDefined()
    expect(config.policies[0].withCheck).toBeDefined()
  })

  it('health_checks has RLS enabled with zero policies (default-deny, no user-data consumer - see CLAUDE.md)', () => {
    const config = getTableConfig(healthChecks)
    expect(config.enableRLS).toBe(true)
    expect(config.policies).toHaveLength(0)
  })

  it('notes/flashcards/quizzes/quiz_attempts denormalize user_id (see schema.ts header comment on why)', () => {
    for (const table of [notes, flashcards, quizzes, quizAttempts]) {
      const config = getTableConfig(table)
      expect(config.columns.some((c) => c.name === 'user_id' && c.notNull)).toBe(true)
    }
  })

  it('users.id has no default - it must be set explicitly to auth.uid(), never auto-generated', () => {
    const config = getTableConfig(users)
    const idColumn = config.columns.find((c) => c.name === 'id')
    expect(idColumn?.hasDefault).toBe(false)
  })

  it('cascade-deletes every user_id/parent-id foreign key, so deleting a user cleans up everything they own', () => {
    for (const table of [documents, notes, flashcards, quizzes, quizAttempts]) {
      const config = getTableConfig(table)
      expect(config.foreignKeys.length).toBeGreaterThan(0)
      for (const fk of config.foreignKeys) {
        expect(fk.onDelete).toBe('cascade')
      }
    }
  })
})
