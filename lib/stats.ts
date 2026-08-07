// MEM-009: the weekly shareable stat card — Meminno's product differentiator
// (see CLAUDE.md's "What Meminno is" and issue #9). This module computes a
// user's trailing-7-day activity from the real schema (lib/db/schema.ts) and
// exposes a small, pure, unit-testable encode/decode contract for turning
// those numbers into the query params app/api/stat-card/route.tsx renders.
//
// Three deliberate design choices worth knowing before touching this:
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
//    getWeeklyStats(), then hands them to the image route as query params
//    via buildStatCardImageUrl(). The image route is a stateless renderer —
//    the same shape as nearly every OG-image implementation (e.g. Vercel's
//    own examples pass title/subtitle via search params) — so it needs no
//    DB credentials or auth, and is safe to be publicly fetchable (which a
//    "shareable" image needs to be anyway, including by social-preview
//    crawlers that never send cookies).
//
// 3. Those query params are HMAC-signed (signStatCardParams() /
//    verifyStatCardSignature() below), not trusted as-is. An earlier version
//    of this route rendered whatever numbers/text a caller put in the URL,
//    which had two real consequences an independent review caught before
//    merge: (a) arbitrary attacker-controlled TEXT rendering into a
//    Meminno-branded PNG on Meminno's own origin (the `period` field had no
//    content validation, only a length cap), and (b) every stat number being
//    trivially forgeable (`?documents=9999&streak=3650&score=100`), which
//    defeats the entire point of a shareable *proof*-of-progress artifact.
//    Signing closes both: buildStatCardImageUrl() is the only code path that
//    can produce a validly-signed URL, and it only ever runs server-side
//    against real getWeeklyStats() output. The image route rejects anything
//    without a valid signature before rendering a single pixel.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, gte, sql as dsql } from 'drizzle-orm'
import { withUserContext } from './db'
import { documents, flashcards, quizzes, quizAttempts } from './db/schema'
import { logger } from './logger'

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

    // jsonb_array_length computed in SQL rather than fetching the whole
    // `questions` blob just to read its length client-side — cheap now, but
    // matters once MEM-008 ships real quizzes with real question-set sizes.
    // The CASE guard (rather than calling jsonb_array_length directly) is
    // deliberate: that function throws if the value isn't a JSON array, and
    // a malformed/unexpected shape should be logged loudly (see below), not
    // crash this whole card.
    const quizzesThisWeek = await tx
      .select({
        id: quizzes.id,
        questionCount: dsql<number | null>`case when jsonb_typeof(${quizzes.questions}) = 'array'
          then jsonb_array_length(${quizzes.questions}) else null end`,
      })
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
    let quizQuestionsGenerated = 0
    for (const row of quizzesThisWeek) {
      if (row.questionCount === null) {
        // Loud on purpose: a headline number silently reporting 0 for a
        // shape it didn't expect is worse than an error someone notices.
        logger.warn({ quizId: row.id }, 'quizzes.questions was not a JSON array — counted as 0 questions')
        continue
      }
      quizQuestionsGenerated += row.questionCount
    }

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
 * activity today OR yesterday) breaks it to zero.
 *
 * KNOWN LIMITATION, not yet fixed: day boundaries here are UTC, not the
 * user's local time, because there is no per-user timezone signal anywhere
 * in this app yet (no profile field — MEM-003/Auth hasn't shipped a place to
 * capture one — and no client-side timezone plumbed through to this
 * server-only computation). This can genuinely UNDERCOUNT a real streak for
 * any user west of UTC, which is most of this product's actual target
 * market: a US-Pacific student who studies every evening around 5-9pm PT is
 * already past midnight UTC (PT is UTC-7/-8), so an evening-Monday session
 * plus a morning-Tuesday session — two distinct real calendar days for that
 * student — can land in the SAME UTC day and collapse into one, or
 * conversely split one contiguous local evening across two UTC days. A
 * hardcoded fixed-offset "fix" (e.g. assuming America/Los_Angeles for
 * everyone) would just trade this bias for a different, also-wrong one for
 * non-Pacific users, so it's deliberately not done here — UTC is at least a
 * consistent, unbiased default until there's a real per-user timezone to
 * bucket by (captured at signup or read client-side and passed through),
 * which is the actual correct fix and a reasonable MEM-003+ follow-up given
 * "day streak" is a headline number on a card meant to be screenshotted.
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
  return `/api/stat-card?${buildStatCardParams(stats).toString()}`
}

/**
 * The rich, unfurl-friendly share link (app/share/stat-card) — what
 * "copy share link" hands out, as opposed to buildStatCardImageUrl()'s raw
 * PNG endpoint. Posting a bare image URL to iMessage/X/LinkedIn renders as a
 * plain link, not a rich preview card, since there's no HTML page with
 * og:image/twitter:card meta around it — this is the actual "shareable" UX
 * the differentiator depends on. Same signed param set as the image URL
 * (the share page re-embeds it as this route's og:image), so anyone who
 * follows the link — or whose social platform scrapes it for a preview —
 * gets the exact same verified numbers.
 */
export function buildStatCardShareUrl(stats: WeeklyStats): string {
  return `/share/stat-card?${buildStatCardParams(stats).toString()}`
}

/** The signed param set both buildStatCardImageUrl() and buildStatCardShareUrl() are built from. */
export function buildStatCardParams(stats: WeeklyStats): URLSearchParams {
  const params = statsToParams(stats)
  params.set('sig', signStatCardParams(params))
  return params
}

function statsToParams(stats: WeeklyStats): URLSearchParams {
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
  return params
}

/**
 * Decodes + defensively clamps query params for the public image route.
 * Every value is bounded (no unbounded numbers/strings from an
 * unauthenticated public route ever reach the renderer unchecked) and
 * malformed input falls back to a safe default rather than throwing.
 *
 * This does NOT verify the signature — call verifyStatCardSignature()
 * first and reject the request if it fails. Kept separate so a caller can't
 * accidentally render parsed-but-unverified params (see app/api/stat-card
 * and app/share/stat-card, both of which verify before parsing/rendering).
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

  const documentsAdded = clampInt(searchParams.get('documents'), 9999)
  const flashcardsGenerated = clampInt(searchParams.get('flashcards'), 9999)
  const quizQuestionsGenerated = clampInt(searchParams.get('questions'), 99999)
  const quizzesTaken = clampInt(searchParams.get('quizzes'), 9999)
  // Defense in depth, independent of signature verification: an explicit
  // empty=1 flag is honored, but a request whose counts are all genuinely
  // zero is ALSO treated as empty even without that flag, so this can never
  // render a contradictory "populated card full of zeros" state regardless
  // of how the params got here.
  const isEmpty =
    searchParams.get('empty') === '1' ||
    (documentsAdded === 0 && flashcardsGenerated === 0 && quizQuestionsGenerated === 0 && quizzesTaken === 0)

  return {
    documentsAdded,
    flashcardsGenerated,
    quizQuestionsGenerated,
    quizzesTaken,
    averageScore,
    scoreTrend,
    streakDays: clampInt(searchParams.get('streak'), 3650),
    isEmpty,
    everActive: searchParams.get('everActive') === '1',
    periodLabel: (searchParams.get('period') ?? '').slice(0, 60),
  }
}

// --- HMAC signing for the shareable-image query params -----------------
//
// See this file's header comment (design choice #3) for why this exists.
// Signs/verifies the exact param set buildStatCardImageUrl() produces, so a
// caller can't add, remove, or edit a single field without invalidating the
// signature. STAT_CARD_SIGNING_SECRET must be set in every environment that
// either builds a share URL (the dashboard page) or verifies one (the image
// route, the /share page) — both run server-side, so this never reaches a
// browser.

function getSigningSecret(): string {
  const secret = process.env.STAT_CARD_SIGNING_SECRET
  if (!secret) {
    throw new Error(
      'STAT_CARD_SIGNING_SECRET is not set — cannot sign or verify stat card share URLs. Set it in .env.local / Vercel / CI.',
    )
  }
  return secret
}

/** Deterministic string to sign: every param except `sig` itself, sorted by key. */
function canonicalizeParams(params: URLSearchParams): string {
  const entries = [...params.entries()].filter(([key]) => key !== 'sig').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
}

function signStatCardParams(params: URLSearchParams): string {
  return createHmac('sha256', getSigningSecret()).update(canonicalizeParams(params)).digest('base64url')
}

/**
 * True only if `params` carries a `sig` that was genuinely produced by
 * signStatCardParams() for exactly this param set (order-independent, but
 * every key/value must match byte-for-byte). Constant-time comparison so
 * this can't be timing-attacked into a forgery. Returns false (never
 * throws) for a missing signature, a wrong one, or a missing/misconfigured
 * secret — every failure mode here should mean "reject the request",
 * handled by the two call sites (app/api/stat-card, app/share/stat-card).
 */
export function verifyStatCardSignature(params: URLSearchParams): boolean {
  const provided = params.get('sig')
  if (!provided) return false

  let expected: string
  try {
    expected = signStatCardParams(params)
  } catch (error) {
    logger.error({ error }, 'Could not verify stat card signature — STAT_CARD_SIGNING_SECRET likely unset')
    return false
  }

  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}
