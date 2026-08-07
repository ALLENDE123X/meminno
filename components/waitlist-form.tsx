"use client"

import * as React from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type Status = "idle" | "loading" | "success" | "error"

export function WaitlistForm({ className }: { className?: string }) {
  const [email, setEmail] = React.useState("")
  const [status, setStatus] = React.useState<Status>("idle")
  const [message, setMessage] = React.useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus("loading")
    setMessage(null)

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        setStatus("error")
        setMessage(data?.error ?? "Something went wrong — try again.")
        return
      }

      setStatus("success")
      setMessage("You're on the list — we'll email you the second we open up.")
      setEmail("")
    } catch {
      setStatus("error")
      setMessage("Couldn't reach the server — check your connection and try again.")
    }
  }

  if (status === "success") {
    return (
      <div className={cn("rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700", className)}>
        {message}
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className={cn("w-full", className)}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@school.edu"
          aria-label="Email address"
          disabled={status === "loading"}
          className="h-11 w-full flex-1 rounded-md border border-gray-300 bg-white px-4 text-sm text-black placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black disabled:opacity-50"
        />
        <Button type="submit" size="lg" disabled={status === "loading"} className="shrink-0">
          {status === "loading" ? "Joining…" : "Join the waitlist"}
        </Button>
      </div>
      {status === "error" && message ? <p className="mt-2 text-sm text-red-600">{message}</p> : null}
      <p className="mt-2 text-xs text-zinc-500">
        We&apos;ll only use your email to let you know when Meminno opens up. See our{" "}
        <Link href="/privacy" className="underline hover:text-zinc-700">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  )
}
