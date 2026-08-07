import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { enforceUploadLimits } from '@/lib/uploadLimits'
import { extractTextFromPdf } from '@/lib/pdfExtract'
import { withUserContext } from '@/lib/db'
import { documents } from '@/lib/db/schema'

// Vercel Functions hard-cap request bodies at 4.5MB platform-wide (413
// FUNCTION_PAYLOAD_TOO_LARGE below that, unconfigurable — see
// https://vercel.com/docs/functions/limitations#request-body-size). 4MB
// leaves headroom for multipart/form-data boundary overhead so the app's
// own, friendlier error message below fires before Vercel's opaque 413
// does. Real coursework PDFs with heavy images can exceed this — see
// ARCHITECTURE.md's MEM-004 entry for why that's a documented v1 gap
// (direct-to-Storage upload, bypassing the function body entirely, is the
// real fix and is deferred) rather than something raised here.
const MAX_PDF_BYTES = 4 * 1024 * 1024
// ~200k characters is a generous multi-chapter/multi-lecture bound (order
// of magnitude: a 300-page book is roughly 500k-700k characters) while still
// keeping a single `documents.raw_text` row, and the eventual MEM-005+ AI
// generation prompt built from it, within sane size.
const MAX_TEXT_CHARS = 200_000

export async function POST(req: Request) {
  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId, plan } = session

  const limit = await enforceUploadLimits(userId, plan)
  if (!limit.ok) {
    logger.warn({ userId, plan }, 'Document upload rate/budget limited')
    return NextResponse.json({ error: limit.reason }, { status: limit.status })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with a "file" or "text" field' }, { status: 400 })
  }

  const file = formData.get('file')
  const pastedText = formData.get('text')
  const titleField = formData.get('title')

  let sourceType: 'pdf' | 'text'
  let rawText: string
  let title: string

  if (file instanceof File) {
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'Only application/pdf files are supported' }, { status: 400 })
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json(
        { error: `PDF must be under ${MAX_PDF_BYTES / (1024 * 1024)}MB` },
        { status: 400 }
      )
    }

    let extracted: string
    try {
      extracted = await extractTextFromPdf(new Uint8Array(await file.arrayBuffer()))
    } catch (error) {
      logger.error({ error, userId }, 'PDF text extraction failed')
      return NextResponse.json({ error: 'Could not read this PDF — it may be corrupted or password-protected' }, { status: 422 })
    }
    if (!extracted) {
      return NextResponse.json(
        { error: 'No extractable text found in this PDF (it may be scanned/image-only)' },
        { status: 422 }
      )
    }

    rawText = extracted
    sourceType = 'pdf'
    title = typeof titleField === 'string' && titleField.trim() ? titleField.trim() : file.name.replace(/\.pdf$/i, '')
  } else if (typeof pastedText === 'string' && pastedText.trim()) {
    if (pastedText.length > MAX_TEXT_CHARS) {
      return NextResponse.json({ error: `Pasted text must be under ${MAX_TEXT_CHARS.toLocaleString()} characters` }, { status: 400 })
    }

    rawText = pastedText.trim()
    sourceType = 'text'
    title = typeof titleField === 'string' && titleField.trim() ? titleField.trim() : rawText.slice(0, 60)
  } else {
    return NextResponse.json({ error: 'Provide either a PDF file ("file") or pasted text ("text")' }, { status: 400 })
  }

  // storage_path stays null even for sourceType='pdf': v1 extracts text
  // synchronously at upload time and stores it directly in raw_text,
  // matching the text-paste storage model, rather than also persisting the
  // original PDF binary to Supabase Storage. See ARCHITECTURE.md's MEM-004
  // entry for the reasoning and what a follow-up ticket would need to add.
  const [doc] = await withUserContext(userId, (tx) =>
    tx.insert(documents).values({ userId, title, sourceType, rawText, storagePath: null }).returning()
  )

  logger.info({ userId, documentId: doc.id, sourceType }, 'Document created')
  return NextResponse.json({ document: doc }, { status: 201 })
}
