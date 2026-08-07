// PDF -> plain text extraction for the upload flow (MEM-004).
//
// Library choice: `unpdf` (not `pdf-parse`, the more commonly reached-for
// option). `unpdf` ships its own serverless-optimized build of Mozilla's
// PDF.js with the worker inlined and browser-only references stripped, so
// it runs in a Vercel Node.js serverless function with no extra config, no
// canvas native dependency, and no filesystem worker file to resolve.
// Verified against a real PDF (see tests/unit/pdfExtract.test.ts, which
// round-trips a minimal real single-page PDF built at test time — not just
// a mocked call — and the manual E2E check in this ticket's PR description
// against an actual multi-page lecture-notes-style PDF).
import { extractText, getDocumentProxy } from 'unpdf'

/**
 * Extracts and concatenates the text content of every page in a PDF.
 * Returns an empty string (not an error) for a PDF with no extractable text
 * layer (e.g. a scanned/image-only PDF) — callers should treat an empty
 * result as "nothing usable came out of this file", not a crash.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes)
  const { text } = await extractText(pdf, { mergePages: true })
  return text.trim()
}
