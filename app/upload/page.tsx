import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { UploadForm } from '@/components/upload-form'

export const metadata: Metadata = {
  title: 'Upload | Meminno',
}

// MEM-004's route, restyled and given real navigation (MEM-008) — see
// components/upload-form.tsx for the actual form/logic. This file is now a
// thin Server Component wrapper (not 'use client') purely so it can render
// SiteHeader, an async Server Component that does a real session check;
// SiteHeader can't be imported into a 'use client' file directly.
export default function UploadPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <UploadForm />
    </div>
  )
}
