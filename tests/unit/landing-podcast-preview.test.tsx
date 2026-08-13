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
})
