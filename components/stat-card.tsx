import { formatWeekRangeLabel, type WeeklyStats, type ScoreTrend } from '@/lib/stats'

// The in-app, live-DOM preview of MEM-009's shareable stat card. Visually
// mirrors app/api/stat-card/route.tsx's rendered PNG (same copy, same
// layout logic) but is real HTML/Tailwind, not Satori-rendered — the two
// are deliberately kept in sync by hand rather than sharing components,
// since the image route's JSX is constrained to Satori's supported CSS
// subset (explicit `display: flex` everywhere, no CSS grid, etc.) and this
// one isn't.
export function StatCard({ stats }: { stats: WeeklyStats }) {
  const periodLabel = formatWeekRangeLabel(stats.periodStart, stats.periodEnd)

  return (
    <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-950 via-slate-950 to-black p-10 text-white shadow-xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-3xl font-bold">Meminno</div>
          <div className="mt-1 text-indigo-300">Weekly Study Recap</div>
        </div>
        <div className="text-slate-300">{periodLabel}</div>
      </div>

      {stats.isEmpty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="text-3xl font-bold">{stats.everActive ? 'Quiet week' : 'Just getting started'}</div>
          <p className="max-w-md text-slate-300">
            {stats.everActive
              ? "No study activity logged this week — jump back in and next week's card will have real numbers."
              : 'Upload your first document to start building your Meminno stat card.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="Documents" value={stats.documentsAdded} />
            <Tile label="Flashcards" value={stats.flashcardsGenerated} />
            <Tile label="Quiz questions" value={stats.quizQuestionsGenerated} />
            <Tile label="Quizzes taken" value={stats.quizzesTaken} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Tile
              label="Avg quiz score"
              value={stats.averageScore !== null ? `${Math.round(stats.averageScore)}%` : 'N/A'}
              hint={trendLabel(stats.scoreTrend)}
            />
            <Tile label="Day streak" value={stats.streakDays} />
          </div>
        </>
      )}

      <div className="mt-10 text-sm text-slate-500">meminno.com</div>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: number | string; hint?: string | null }) {
  return (
    <div className="rounded-2xl bg-white/10 p-5">
      <div className="text-4xl font-bold">{value}</div>
      <div className="mt-1 text-slate-300">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  )
}

function trendLabel(trend: ScoreTrend): string | null {
  if (trend === 'up') return 'Trending up'
  if (trend === 'down') return 'Needs a boost'
  if (trend === 'flat') return 'Steady'
  return null
}
