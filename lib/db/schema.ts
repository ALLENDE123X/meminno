// Meminno database schema.
//
// Deliberately trivial for MEM-001 (repo + infra scaffold ticket) — this
// exists only to prove the Drizzle + drizzle-kit migrate pipeline works
// end to end against a fresh Supabase project. The real schema (users,
// documents, notes, flashcards, quizzes, chat messages, weekly stat cards,
// etc.) is scoped to MEM-002, not this ticket.
//
// Mirrors the pattern of Propinno's lib/db/schema.ts (pgTable + pgEnum from
// drizzle-orm/pg-core), not its domain content.
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const healthChecks = pgTable('health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  note: text('note').notNull().default('MEM-001 scaffold'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
