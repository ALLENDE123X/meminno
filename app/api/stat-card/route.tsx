import { ImageResponse } from 'next/og'
import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { limitRequest } from '@/lib/ratelimit'
import { parseStatCardImageParams, type StatCardImageParams, type ScoreTrend } from '@/lib/stats'

// MEM-009's shareable stat-card image. Deliberately public and
// unauthenticated — see lib/stats.ts's header comment for why: it takes
// pre-computed, already-clamped numbers via query params instead of a user
// id, so there is nothing here to leak and no DB/auth dependency at all. The
// dashboard page (which DOES require a session) is the only place that
// builds this URL, via buildStatCardImageUrl().
//
// next/og's ImageResponse (Satori under the hood) is used rather than a new
// dependency — it ships with Next.js 16 already (confirmed via
// `require.resolve('next/og')` before writing this), so no @vercel/og
// install was needed. Rendered and screenshot-verified locally via `npm run
// dev` before this route was considered done — see the MEM-009 PR
// description for the verification notes.

const WIDTH = 1200
const HEIGHT = 630

export async function GET(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? '127.0.0.1'
  // meminno- prefix: shared Redis instance with Propinno (see CLAUDE.md).
  // Rate limited because this route does real CPU work (image rendering) on
  // a public, unauthenticated path.
  const { success } = await limitRequest(`meminno-stat-card-image_${ip}`)
  if (!success) {
    logger.warn({ ip }, 'Stat card image rate limited')
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const stats = parseStatCardImageParams(searchParams)

  return new ImageResponse(<StatCardImage {...stats} />, {
    width: WIDTH,
    height: HEIGHT,
    headers: {
      // The numbers are baked into the URL itself (a new week/session builds
      // a new URL via buildStatCardImageUrl), so a given URL's response
      // never changes - safe to cache aggressively, including by whatever
      // fetches it for a social-preview crawl.
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}

function StatCardImage(props: StatCardImageParams) {
  const {
    documentsAdded,
    flashcardsGenerated,
    quizQuestionsGenerated,
    quizzesTaken,
    averageScore,
    scoreTrend,
    streakDays,
    isEmpty,
    everActive,
    periodLabel,
  } = props

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0f172a',
        backgroundImage: 'linear-gradient(135deg, #312e81 0%, #0f172a 55%, #020617 100%)',
        padding: 64,
        color: 'white',
        fontFamily: 'Arial, Helvetica, sans-serif',
      }}
    >
      <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 42, fontWeight: 700 }}>Meminno</div>
          <div style={{ fontSize: 22, color: '#a5b4fc', marginTop: 6 }}>Weekly Study Recap</div>
        </div>
        <div style={{ fontSize: 20, color: '#cbd5e1' }}>{periodLabel}</div>
      </div>

      {isEmpty ? (
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 44, fontWeight: 700, marginBottom: 20 }}>
            {everActive ? 'Quiet week' : 'Just getting started'}
          </div>
          <div style={{ display: 'flex', fontSize: 24, color: '#cbd5e1', maxWidth: 780 }}>
            {everActive
              ? "No study activity logged this week - jump back in and next week's card will have real numbers."
              : 'Upload your first document to start building your Meminno stat card.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', gap: 24 }}>
          <div style={{ display: 'flex', gap: 24 }}>
            <StatTile label="Documents" value={String(documentsAdded)} />
            <StatTile label="Flashcards" value={String(flashcardsGenerated)} />
            <StatTile label="Quiz questions" value={String(quizQuestionsGenerated)} />
            <StatTile label="Quizzes taken" value={String(quizzesTaken)} />
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <StatTile
              label="Avg quiz score"
              value={averageScore !== null ? `${averageScore}%` : 'N/A'}
              hint={trendLabel(scoreTrend)}
            />
            <StatTile label="Day streak" value={String(streakDays)} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', marginTop: 24, fontSize: 18, color: '#64748b' }}>meminno.com</div>
    </div>
  )
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 20,
        padding: '26px 22px',
      }}
    >
      <div style={{ display: 'flex', fontSize: 54, fontWeight: 700 }}>{value}</div>
      <div style={{ display: 'flex', fontSize: 20, color: '#cbd5e1', marginTop: 6 }}>{label}</div>
      {hint ? <div style={{ display: 'flex', fontSize: 16, color: '#94a3b8', marginTop: 4 }}>{hint}</div> : null}
    </div>
  )
}

function trendLabel(trend: ScoreTrend): string | null {
  if (trend === 'up') return 'Trending up'
  if (trend === 'down') return 'Needs a boost'
  if (trend === 'flat') return 'Steady'
  return null
}
