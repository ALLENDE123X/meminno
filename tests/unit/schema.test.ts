import { describe, it, expect } from 'vitest'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
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
  const dialect = new PgDialect()
  const render = (expr: SQL | undefined) => dialect.sqlToQuery(expr!).sql

  it.each(Object.entries(userTables))('%s has RLS enabled with exactly one identity-scoped policy', (_name, table) => {
    const config = getTableConfig(table)
    expect(config.enableRLS).toBe(true)
    expect(config.policies).toHaveLength(1)
    expect(config.policies[0].for).toBe('all')
    // Both real access paths, and ONLY those: `authenticated` (Supabase
    // PostgREST) and `meminno_rls` (the app's runtime connection). The
    // table-owning `meminno_app` migration role must never appear here -
    // that plus FORCE ROW LEVEL SECURITY is what keeps it unable to read
    // user data (MEM-002-fix, issue #14).
    expect(config.policies[0].to).toEqual(['authenticated', 'meminno_rls'])
    // Every policy must scope by identity, not leave using/withCheck unset
    // (an unset `using` on a permissive policy defaults to allowing
    // everything - the one mistake that would make a policy present but
    // silently do nothing).
    expect(config.policies[0].using).toBeDefined()
    expect(config.policies[0].withCheck).toBeDefined()
  })

  it.each(Object.entries(userTables))('%s scopes by public.meminno_current_user_id(), never the retired auth-schema proxy', (_name, table) => {
    const policy = getTableConfig(table).policies[0]
    for (const expr of [render(policy.using), render(policy.withCheck)]) {
      expect(expr).toContain('public.meminno_current_user_id()')
      // The MEM-002 proxy was SECURITY INVOKER over auth.uid(), so only a
      // role with `auth` schema USAGE could evaluate it - which the runtime
      // role can never be granted. A policy that regressed to it would
      // default-deny every app query.
      expect(expr).not.toContain('rls_current_user_id')
      expect(expr).not.toContain('auth.uid')
    }
  })

  it('health_checks has RLS enabled with zero policies (default-deny, no user-data consumer - see CLAUDE.md)', () => {
    const config = getTableConfig(healthChecks)
    expect(config.enableRLS).toBe(true)
    expect(config.policies).toHaveLength(0)
  })

  it('withCheck on notes/flashcards/quizzes/quiz_attempts also verifies parent-row ownership (issue #23)', () => {
    // Regression pin for issue #23: withCheck used to be an identical flat
    // `user_id = caller` check to `using`, which let a caller forge a child
    // row's parent FK (document_id/note_id/quiz_id) while claiming
    // ownership via user_id alone. Each entry below is [table, parent
    // table, parent FK column] - the EXISTS subquery must reference all
    // three. `using` is deliberately NOT asserted here - it stays the flat
    // check on purpose (see schema.ts's header comment).
    const parentChecks: Array<[Parameters<typeof getTableConfig>[0], string, string]> = [
      [notes, 'documents', 'document_id'],
      [flashcards, 'notes', 'note_id'],
      [quizzes, 'notes', 'note_id'],
      [quizAttempts, 'quizzes', 'quiz_id'],
    ]
    for (const [table, parentTable, parentColumn] of parentChecks) {
      const policy = getTableConfig(table).policies[0]
      const withCheck = render(policy.withCheck)
      expect(withCheck).toContain('EXISTS')
      expect(withCheck).toContain(`public.${parentTable}`)
      expect(withCheck).toContain(parentColumn)
      // Still requires user_id = caller too - EXISTS alone (without the
      // user_id check) would let anyone claim any row as long as SOME
      // caller-visible parent existed, not necessarily one they own via
      // this specific child row's own user_id.
      expect(withCheck).toContain('public.meminno_current_user_id()) = user_id')
    }
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
