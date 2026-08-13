import { Card, CardContent } from "@/components/ui/card";

// MEM-018 (issue #88): the visual for app/page.tsx's podcast section.
//
// A STATIC MOCKUP, deliberately — no audio file, no state, no 'use client'.
// This is a server component that renders a picture of a player, not a
// player: it exists so a first-time visitor can see what "Audio Overview"
// actually means before signing up. The real, working player is
// components/podcast-section.tsx (a plain <audio controls> over a signed
// Supabase Storage URL), which is behind auth and needs a real generated
// podcast; embedding a sample .wav here would mean shipping a binary asset
// into the repo and paying for its bandwidth on every landing-page view,
// for a marketing page whose only job is to get the visitor to sign in.
//
// Everything shown is illustrative sample content, chosen to be obviously a
// mock (a made-up biology chapter) rather than to imply a real recording.
// The numbers it shows are honest about the real feature: two speakers, and
// a ~5-minute episode (lib/podcastScript.ts caps a script at 800 words,
// which measured at 4.63 minutes of synthesized audio during MEM-014).
//
// Accessibility: the whole card is aria-hidden except the transcript
// snippet's own text, and the sighted-only content (waveform, transport
// controls, timestamps) is decorative — a screen reader gets the section's
// real prose in app/page.tsx instead of a fake player it can't operate. The
// transport "buttons" are <div>s, not <button>s, on purpose: nothing here is
// interactive, and a real focusable control that does nothing when clicked
// would be worse than no control at all.

// Fixed, hand-picked bar heights (percentages). Deliberately NOT random:
// a server-rendered component that randomizes produces a hydration mismatch,
// and a waveform that changes on every render reads as noise rather than as
// a picture of one specific episode.
const WAVEFORM = [
  38, 62, 45, 78, 54, 88, 70, 46, 92, 60, 74, 40, 66, 84, 52, 96, 68, 44, 80, 58, 72, 48, 90, 64, 42, 76, 56, 86, 50,
  70, 36, 62, 82, 46, 74, 54, 66, 40, 88, 58,
];

// Index into WAVEFORM up to which the "already played" styling applies —
// matches the 2:14-of-5:03 timestamps below (~44%).
const PLAYED_THROUGH = 18;

const TRANSCRIPT = [
  {
    speaker: "A",
    line: "Okay, so chapter eight is really all about how a plant turns light into sugar — that's the whole story.",
  },
  {
    speaker: "B",
    line: "Wait, so the light isn't the food? I always thought the plant was, like, eating the sunlight.",
  },
  {
    speaker: "A",
    line: "Right, that's the part everyone mixes up. The light is the energy source, the sugar is the food it builds.",
  },
];

export function LandingPodcastPreview() {
  // min-w-0 on the Card is load-bearing, not decoration: this card is placed
  // as a grid item in app/page.tsx, and a grid item's default `min-width: auto`
  // means the column track can't shrink below the card's min-content width
  // (~406px, floored by the 40-bar waveform's min-w-[2px] bars). That
  // overflowed the page horizontally at every common phone width (measured:
  // body.scrollWidth 430 vs clientWidth 390 at 390px). min-width: 0 lets the
  // track shrink to its container; everything inside already truncates/wraps.
  // Measured caveat: putting min-w-0 on the grid CONTAINER instead does
  // nothing — it's the item's automatic minimum size that sizes the track.
  return (
    <Card className="w-full min-w-0">
      <CardContent className="flex flex-col gap-5 p-6">
        {/* Episode header */}
        <div aria-hidden="true" className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-black">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" className="h-7 w-7">
              <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold">Photosynthesis — Ch. 8 lecture notes</p>
            <p className="mt-0.5 text-sm text-zinc-500">Audio Overview · 2 hosts · 5 min</p>
          </div>
        </div>

        {/* Waveform */}
        <div aria-hidden="true" className="flex h-16 items-center gap-[3px]">
          {WAVEFORM.map((height, i) => (
            <span
              key={i}
              style={{ height: `${height}%` }}
              className={`w-full min-w-[2px] rounded-full ${i <= PLAYED_THROUGH ? "bg-black" : "bg-zinc-200"}`}
            />
          ))}
        </div>

        {/* Transport + timestamps */}
        <div aria-hidden="true" className="flex items-center justify-between">
          <span className="text-xs tabular-nums text-zinc-500">2:14</span>
          <div className="flex items-center gap-5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5 text-zinc-400">
              <path d="M11 5 4 12l7 7M20 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black">
              <svg viewBox="0 0 24 24" fill="white" className="h-4 w-4">
                <path d="M7 4h3v16H7zM14 4h3v16h-3z" />
              </svg>
            </span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5 text-zinc-400">
              <path d="m13 5 7 7-7 7M4 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="text-xs tabular-nums text-zinc-500">5:03</span>
        </div>

        {/* Transcript snippet — the part that actually shows what a
            two-host Audio Overview sounds like. Real text, not aria-hidden. */}
        <div className="flex flex-col gap-3 border-t border-zinc-200 pt-5">
          {TRANSCRIPT.map((turn) => (
            <div key={turn.line} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  turn.speaker === "A" ? "bg-black text-white" : "bg-zinc-200 text-zinc-700"
                }`}
              >
                {turn.speaker}
              </span>
              <p className="text-sm leading-relaxed text-zinc-600">
                <span className="sr-only">{`Host ${turn.speaker}: `}</span>
                {turn.line}
              </p>
            </div>
          ))}
          <p className="text-xs text-zinc-400">Sample transcript. Your podcast is generated from your own material.</p>
        </div>
      </CardContent>
    </Card>
  );
}
