import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LandingPodcastPreview } from '@/components/landing-podcast-preview'

// MEM-018 (issue #88): components/landing-podcast-preview.tsx is a static
// marketing mockup with no state and no interactivity, so there's no state
// machine to cover the way tests/unit/podcast-section.test.tsx covers the
// real in-app player. What IS worth pinning is the two things a future edit
// could quietly break and nobody would notice on a marketing page:
//
//   1. It stays a MOCKUP. No <audio> element and no interactive control, so
//      it can never start behaving like a half-working player (or start
//      pulling a real media asset) without a test failing first.
//   2. The sample transcript is disclosed as a sample, and is readable to a
//      screen reader with its speakers attributed — the decorative player
//      chrome around it is aria-hidden, so the transcript is the only thing
//      assistive tech gets from this card.

describe('LandingPodcastPreview', () => {
  it('renders the sample transcript with both hosts attributed', () => {
    render(<LandingPodcastPreview />)

    expect(screen.getByText(/chapter eight is really all about/i)).toBeTruthy()
    // Host A speaks twice in the sample, Host B once — assert on the counts
    // rather than existence, so a future edit that drops one side of the
    // back-and-forth (the whole point of an Audio Overview) fails here.
    expect(screen.getAllByText(/Host A:/)).toHaveLength(2)
    expect(screen.getAllByText(/Host B:/)).toHaveLength(1)
  })

  it('discloses that the transcript is a sample, not a real recording', () => {
    render(<LandingPodcastPreview />)

    expect(screen.getByText(/Sample transcript/i)).toBeTruthy()
  })

  it('is a static mockup: no audio element and no interactive controls', () => {
    const { container } = render(<LandingPodcastPreview />)

    expect(container.querySelector('audio')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
  })

  // Regression pin for the mobile-overflow bug the first review round caught.
  // This card is a grid item in app/page.tsx, and a grid item's default
  // `min-width: auto` stopped the column track from shrinking below the card's
  // ~406px min-content width — which overflowed the whole page horizontally at
  // every common phone width (measured: body.scrollWidth 430 vs clientWidth
  // 390 at a 390px viewport). jsdom does no layout, so this can only assert the
  // class is present, not the resulting width; the real check is the browser
  // measurement recorded in ARCHITECTURE.md. Still worth pinning, because
  // `min-w-0` reads like a decorative utility and is exactly the kind of class
  // a future tidy-up would delete without knowing it is load-bearing.
  it('keeps min-w-0 on the root card so it can shrink inside a grid track', () => {
    const { container } = render(<LandingPodcastPreview />)

    expect(container.firstElementChild?.className).toContain('min-w-0')
  })
})
