'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

// MEM-008: a real flip/reveal card, not a static front/back list — the
// ticket brief explicitly asks for this ("a real flippable/reveal UI, not
// just a list"). Pure CSS 3D transform (perspective + rotateY), no extra
// dependency — flip state is local to each card so a grid of these can be
// flipped independently. `back-visible` is toggled via inline transform
// rather than Tailwind's `group`/`peer` variants because each card needs
// its own independent boolean, not a shared one.
export function Flashcard({ front, back }: { front: string; back: string }) {
  const [flipped, setFlipped] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setFlipped((f) => !f)}
      aria-pressed={flipped}
      aria-label={flipped ? 'Showing answer — click to show the question' : 'Showing question — click to reveal the answer'}
      className="group h-48 w-full text-left [perspective:1000px] focus-visible:outline-none"
    >
      <div
        className={cn(
          'relative h-full w-full rounded-lg border border-border bg-card shadow-sm transition-transform duration-500 [transform-style:preserve-3d] group-focus-visible:ring-2 group-focus-visible:ring-ring',
          flipped && '[transform:rotateY(180deg)]'
        )}
      >
        <div className="absolute inset-0 flex flex-col justify-between p-5 [backface-visibility:hidden]">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Question</span>
          <p className="text-base font-medium text-card-foreground">{front}</p>
          <span className="text-xs text-muted-foreground">Tap to reveal answer</span>
        </div>
        <div className="absolute inset-0 flex flex-col justify-between rounded-lg bg-accent p-5 text-accent-foreground [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <span className="text-xs font-medium uppercase tracking-wide opacity-80">Answer</span>
          <p className="text-base font-medium">{back}</p>
          <span className="text-xs opacity-80">Tap to see question</span>
        </div>
      </div>
    </button>
  )
}
