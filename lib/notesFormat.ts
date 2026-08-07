// MEM-008: shared notes.content parsing, used by both a server component
// (app/dashboard/documents/[id]/page.tsx, for the initial render) and a
// client component (components/document-workspace.tsx, after a fresh
// "Generate notes" response). Deliberately a standalone module with no
// server-only imports (no 'openai', no lib/notesGeneration.ts) so it's safe
// to bundle into client code — lib/notesGeneration.ts's generatedNotesSchema
// already validates this shape at generation time via zod, but that module
// pulls in the 'openai' SDK, which has no business in a client bundle just
// to read a JSON string back out.
//
// notes.content (lib/db/schema.ts) is a plain `text` column holding
// JSON.stringify'd { title, summary, sections, keyConcepts } (MEM-005).
// Deliberately re-implements the same lenient render used by
// lib/flashcardsGeneration.ts's renderNotesContentForPrompt /
// lib/quizGeneration.ts's renderNotesContent (not imported, same "don't
// couple sibling modules" convention documented in both) — a notes row
// saved by a future/older format still degrades gracefully to "show the raw
// text" here too.
export type ParsedNotes = {
  title: string
  summary: string
  sections: { heading: string; bullets: string[] }[]
  keyConcepts: { term: string; definition: string }[]
}

/** Parses a notes.content string into a display-ready structure, or null if it doesn't match the expected shape (caller should fall back to rendering the raw string). */
export function parseNotesContent(raw: string): ParsedNotes | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return null
    if (typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') return null

    const sections = Array.isArray(parsed.sections)
      ? parsed.sections
          .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
          .map((s) => ({
            heading: typeof s.heading === 'string' ? s.heading : '',
            bullets: Array.isArray(s.bullets) ? s.bullets.filter((b): b is string => typeof b === 'string') : [],
          }))
      : []

    const keyConcepts = Array.isArray(parsed.keyConcepts)
      ? parsed.keyConcepts
          .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
          .map((c) => ({
            term: typeof c.term === 'string' ? c.term : '',
            definition: typeof c.definition === 'string' ? c.definition : '',
          }))
      : []

    return { title: parsed.title, summary: parsed.summary, sections, keyConcepts }
  } catch {
    return null
  }
}
