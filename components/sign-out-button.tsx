'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

// MEM-008: signs out via the existing DELETE /api/me route (MEM-003 — this
// ticket adds the first real UI caller of it) and sends the visitor back to
// the marketing page, matching the "signed out -> nothing left to protect"
// state everywhere else in this app.
export function SignOutButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    setLoading(true)
    try {
      await fetch('/api/me', { method: 'DELETE' })
    } finally {
      router.push('/')
      router.refresh()
    }
  }

  return (
    <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={handleClick} className="ml-1">
      {loading ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
