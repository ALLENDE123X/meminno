import { describe, it, expect } from 'vitest'
import { extractTextFromPdf } from '@/lib/pdfExtract'

// A minimal-but-real single-page PDF (not a mock of the PDF.js API) — hand
// -built PDF syntax with one Helvetica text run, verified independently
// with a throwaway node script against the real `unpdf` package before
// this test was written (see this ticket's PR description). PDF.js parses
// this successfully even without a well-formed xref table by falling back
// to scanning for `obj` markers, exactly like it does for many real-world
// "slightly broken" PDFs.
function buildMinimalPdf(text: string): Uint8Array {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 144] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${text.length + 24} >>
stream
BT /F1 24 Tf 20 100 Td (${text}) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF
`
  return new TextEncoder().encode(pdf)
}

describe('extractTextFromPdf', () => {
  it('extracts real text from a real PDF byte stream', async () => {
    const bytes = buildMinimalPdf('Hello Meminno')
    const text = await extractTextFromPdf(bytes)
    expect(text).toContain('Hello Meminno')
  })

  it('returns an empty (trimmed) string for a page with no text content, not a throw', async () => {
    const bytes = buildMinimalPdf('')
    const text = await extractTextFromPdf(bytes)
    expect(text).toBe('')
  })

  it('rejects bytes that are not a PDF at all', async () => {
    const bytes = new TextEncoder().encode('this is definitely not a pdf')
    await expect(extractTextFromPdf(bytes)).rejects.toThrow()
  })
})
