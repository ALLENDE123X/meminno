'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

/** Copies the absolute URL for a same-origin path (e.g. the stat-card image route) to the clipboard. */
export function CopyShareLinkButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  async function handleClick() {
    try {
      const url = new URL(path, window.location.origin).toString()
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can fail (permissions, insecure context) - fail silently
      // rather than throwing in the UI; the download button next to this one
      // is a working fallback either way.
    }
  }

  return (
    <Button type="button" variant="outline" onClick={handleClick}>
      {copied ? 'Link copied!' : 'Copy share link'}
    </Button>
  )
}
