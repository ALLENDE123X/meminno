// MEM-009: the weekly shareable stat card — Meminno's product differentiator
// (see CLAUDE.md's "What Meminno is" and issue #9). This module computes a
// user's trailing-7-day activity from the real schema (lib/db/schema.ts) and
// exposes a small, pure, unit-testable encode/decode contract for turning
// those numbers into the query params app/api/stat-card/route.tsx renders.
//
// Two deliberate design choices worth knowing before touching this:
//
// 1. Every DB query here goes through withUserContext() (lib/db/index.ts),
//    never a bare db.select() — that's what makes these rows actually
//    RLS-scoped to the caller instead of returning zero rows. See
//    lib/db/schema.ts's header comment for why.
//
// 2. The shareable IMAGE route does not take a userId or touch the database
//    at all. MEM-003 (Supabase Auth wiring / sign-up flow) has not shipped
//    yet, so there is no way to derive "which user" from an unauthenticated
//    request — and even once it exists, a public "give me user X's stats"
//    endpoint keyed by a guessable id would leak private study activity to
//    anyone who guesses/knows a user id. Instead, the caller (the dashboard
//    page, which DOES require a session) computes the real numbers here via
//    getWeeklyStats(), then hands them to the image route as plain query
//    params via buildStatCardImageUrl(). The image route is a pure,
//    stateless renderer — the same shape as nearly every OG-image
//    implementation (e.g. Vercel's own examples pass title/subtitle via
//    search params) — so it needs no DB credentials, no auth, and is safe to
//    be publicly fetchable (which a "shareable" image needs to be anyway,
//    including by social-preview crawlers that never send cookies).
import { and, eq, gte, sql as dsql } from 'drizzle-orm'
import { withUserContext } from './db'
import { documents, flashcards, quizzes, quizAttempts } from './db/schema'

export type ScoreTrend = 'up' | 'down' | 'flat' | null

export interface WeeklyStats {
  userId: string
  periodStart: Date
  periodEnd: Date
  documentsAdded: number
  flashcardsGenerated: number
  quizQuestionsGenerated: number
  quizzesTaken: number
  /** Average quiz_attempts.score (0-100) over the trailing 7 days, or null if none were taken. */
  averageScore: number | null
  /** vs. the 7 days before that. Null if either week has no attempts to compare. */
  scoreTrend: ScoreTrend
  /** Consecutive days (ending today or yesterday) with at least one document or quiz attempt. */
  streakDays: number
  /** Whether this user has ever had any activity, all-time — distinguishes a brand-new
   *  account from an existing one that was just quiet this week, so the empty state can
   *  say something honest instead of one generic "nothing here" message for both. */
  everActive: boolean
  /** True when every one of this week's counts is zero — the UI's signal to show an
   *  explicit empty state instead of a card full of honest zeros. */
  isEmpty: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
// Bounds the streak/this-week query window. 60 days is far more runway than
// any realistic current streak this early in the product's life, and keeps
// the query cheap and independent of how old the account is.
const STREAK_LOOKBACK_MS = 60 * DAY_MS

/**
 * Computes a user's trailing-7-day study activity from the real schema.
 * Every number here is a real count against live (even if currently sparse
 * or zero) data — nothing is fabricated in this function or by its callers.
 */
export async function getWeeklyStats(userId: string, now: Date = new Date()): Promise<WeeklyStats> {
  const periodEnd = now
  const periodStart = new Date(now.getTime() - WEEK_MS)
  const previousPeriodStart = new Date(now.getTime() - 2 * WEEK_MS)
  const streakCutoff = new Date(now.getTime() - STREAK_LOOKBACK_MS)

  return withUserContext(userId, async (tx) => {
    // Bounded-lookback rows double as both "this week's" counts (filtered
    // client-side below) and the streak calculation's activity calendar, so
    // this needs one query each instead of three.
    const recentDocs = await tx
      .select({ createdAt: documents.createdAt })
      .from(documents)
      .where(and(eq(documents.userId, userId), gte(documents.createdAt, streakCutoff)))

    const recentAttempts = await tx
      .select({ createdAt: quizAttempts.createdAt, score: quizAttempts.score })
      .from(quizAttempts)
      .where(and(eq(quizAttempts.userId, userId), gte(quizAttempts.createdAt, streakCutoff)))

    const flashcardsThisWeek = await tx
      .select({ createdAt: flashcards.createdAt })
      .from(flashcards)
      .where(and(eq(flashcards.userId, userId), gte(flashcards.createdAt, periodStart)))

    const quizzesThisWeek = await tx
      .select({ questions: quizzes.questions })
      .from(quizzes)
      .where(and(eq(quizzes.userId, userId), gte(quizzes.createdAt, periodStart)))

    const [{ count: allTimeDocs }] = await tx
      .select({ count: dsql<number>`count(*)::int` })
      .from(documents)
      .where(eq(documents.userId, userId))

    const [{ count: allTimeAttempts }] = await tx
      .select({ count: dsql<number>`count(*)::int` })
      .from(quizAttempts)
      .where(eq(quizAttempts.userId, userId))

    const documentsAdded = recentDocs.filter((d) => d.createdAt >= periodStart).length
    const flashcardsGenerated = flashcardsThisWeek.length
    const quizQuestionsGenerated = quizzesThisWeek.reduce(
      (sum, row) => sum + (Array.isArray(row.questions) ? row.questions.length : 0),
      0,
    )

    const attemptsThisWeek = recentAttempts.filter((a) => a.createdAt >= periodStart)
    const attemptsPreviousWeek = recentAttempts.filter(
      (a) => a.createdAt >= previousPeriodStart && a.createdAt < periodStart,
    )
    const averageScore = average(attemptsThisWeek.map((a) => a.score))
    const previousAverageScore = average(attemptsPreviousWeek.map((a) => a.score))

    const activityTimestamps = [...recentDocs.map((d) => d.createdAt), ...recentAttempts.map((a) => a.createdAt)]
    const quizzesTaken = attemptsThisWeek.length

    return {
      userId,
      periodStart,
      periodEnd,
      documentsAdded,
      flashcardsGenerated,
      quizQuestionsGenerated,
      quizzesTaken,
      averageScore,
      scoreTrend: computeScoreTrend(averageScore, previousAverageScore),
      streakDays: computeStreakDays(activityTimestamps, now),
      everActive: allTimeDocs > 0 || allTimeAttempts > 0,
      isEmpty: documentsAdded === 0 && flashcardsGenerated === 0 && quizQuestionsGenerated === 0 && quizzesTaken === 0,
    }
  })
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Pure and unit-tested separately from the DB query above (see tests/unit/stats.test.ts). */
export function computeScoreTrend(currentAvg: number | null, previousAvg: number | null): ScoreTrend {
  if (currentAvg === null || previousAvg === null) return null
  const delta = currentAvg - previousAvg
  if (Math.abs(delta) < 1) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

/**
 * Current streak, in days, ending today or yesterday. "Ending yesterday" is
 * deliberate forgiveness for today simply not having happened yet — a user
 * who studied every day through yesterday still has a live streak at 9am
 * today before they've done anything yet. Two consecutive missed days (no
 * activity today OR yesterday) breaks it to zero. All day boundaries are UTC
 * for determinism, matching how the DB stores `created_at` (timestamptz).
 */
export function computeStreakDays(activityTimestamps: Date[], now: Date = new Date()): number {
  const activeDays = new Set(activityTimestamps.map(toUtcDayKey))
  const cursor = startOfUtcDay(now)

  if (!activeDays.has(toUtcDayKey(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    if (!activeDays.has(toUtcDayKey(cursor))) return 0
  }

  let streak = 0
  while (activeDays.has(toUtcDayKey(cursor))) {
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function toUtcDayKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10)
}

const WEEK_LABEL_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function formatWeekRangeLabel(start: Date, end: Date): string {
  const startLabel = WEEK_LABEL_FORMAT.format(start)
  const endLabel = WEEK_LABEL_FORMAT.format(end)
  const endYear = end.getUTCFullYear()
  if (start.getUTCFullYear() === endYear) {
    return `${startLabel} - ${endLabel}, ${endYear}`
  }
  return `${startLabel}, ${start.getUTCFullYear()} - ${endLabel}, ${endYear}`
}

// --- Shareable-image query-param contract -----------------------------
//
// Shared by the dashboard page (encode) and app/api/stat-card/route.tsx
// (decode) so the two never drift apart. Deliberately a narrower shape than
// WeeklyStats — no userId, no raw Date objects (only a pre-formatted label)
// — since these values end up in a public URL.

export interface StatCardImageParams {
  documentsAdded: number
  flashcardsGenerated: number
  quizQuestionsGenerated: number
  quizzesTaken: number
  averageScore: number | null
  scoreTrend: ScoreTrend
  streakDays: number
  isEmpty: boolean
  everActive: boolean
  periodLabel: string
}

export function buildStatCardImageUrl(stats: WeeklyStats): string {
  const params = new URLSearchParams({
    documents: String(stats.documentsAdded),
    flashcards: String(stats.flashcardsGenerated),
    questions: String(stats.quizQuestionsGenerated),
    quizzes: String(stats.quizzesTaken),
    streak: String(stats.streakDays),
    empty: stats.isEmpty ? '1' : '0',
    everActive: stats.everActive ? '1' : '0',
    period: formatWeekRangeLabel(stats.periodStart, stats.periodEnd),
  })
  if (stats.averageScore !== null) params.set('score', String(Math.round(stats.averageScore)))
  if (stats.scoreTrend) params.set('trend', stats.scoreTrend)
  return `/api/stat-card?${params.toString()}`
}

/**
 * Decodes + defensively clamps query params for the public image route.
 * Every value is bounded (no unbounded numbers/strings from an
 * unauthenticated public route ever reach the renderer unchecked) and
 * malformed input falls back to a safe default rather than throwing.
 */
export function parseStatCardImageParams(searchParams: URLSearchParams): StatCardImageParams {
  const clampInt = (raw: string | null, max: number): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return 0
    return Math.min(max, Math.max(0, Math.round(n)))
  }

  const scoreRaw = searchParams.get('score')
  const scoreNum = scoreRaw !== null ? Number(scoreRaw) : NaN
  const averageScore = Number.isFinite(scoreNum) ? Math.min(100, Math.max(0, Math.round(scoreNum))) : null

  const trendRaw = searchParams.get('trend')
  const scoreTrend: ScoreTrend = trendRaw === 'up' || trendRaw === 'down' || trendRaw === 'flat' ? trendRaw : null

  return {
    documentsAdded: clampInt(searchParams.get('documents'), 9999),
    flashcardsGenerated: clampInt(searchParams.get('flashcards'), 9999),
    quizQuestionsGenerated: clampInt(searchParams.get('questions'), 99999),
    quizzesTaken: clampInt(searchParams.get('quizzes'), 9999),
    averageScore,
    scoreTrend,
    streakDays: clampInt(searchParams.get('streak'), 3650),
    isEmpty: searchParams.get('empty') === '1',
    everActive: searchParams.get('everActive') === '1',
    periodLabel: (searchParams.get('period') ?? '').slice(0, 60),
  }
}
