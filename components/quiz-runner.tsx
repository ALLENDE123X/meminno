'use client'

import { useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'

type Question = { question: string; options: string[]; correctAnswer: string }
type QuestionResult = { question: string; options: string[]; correctAnswer: string; userAnswer: string; isCorrect: boolean }
type AttemptResult = { score: number; correctCount: number; totalQuestions: number; results: QuestionResult[] }
type Phase = 'taking' | 'submitting' | 'error' | 'done'

// MEM-008: the real question-by-question quiz-taking UI the ticket brief
// calls out as "the part no prior ticket built" — MEM-007 generated and
// persisted quizzes but explicitly deferred taking/scoring/persisting an
// attempt to this ticket. Scoring itself is NOT computed here: this
// component only collects an answer per question and POSTs the raw answers
// to app/api/quizzes/[id]/attempts, which is the sole source of truth for
// `score` (a client can't forge a better score than what it actually
// answered — the route recomputes it server-side from the quiz's own
// stored questions, never trusting a client-supplied score).
export function QuizRunner({ quizId, questions, documentId }: { quizId: string; questions: Question[]; documentId: string }) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<string[]>(() => new Array(questions.length).fill(''))
  const [phase, setPhase] = useState<Phase>('taking')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AttemptResult | null>(null)

  // index is local numeric component state, bounded to [0, questions.length)
  // by handleNextOrSubmit/Back below — not arbitrary/attacker-controlled
  // input, so this is not a real object-injection risk despite the linter
  // warning (matches components/ui/button.tsx's existing disable for the
  // same class of false positive).
  // eslint-disable-next-line security/detect-object-injection
  const current = questions[index]
  const isLast = index === questions.length - 1
  // eslint-disable-next-line security/detect-object-injection
  const hasAnswered = answers[index] !== ''

  function selectAnswer(option: string) {
    setAnswers((prev) => prev.map((a, i) => (i === index ? option : a)))
  }

  async function handleNextOrSubmit() {
    if (!isLast) {
      setIndex((i) => i + 1)
      return
    }
    setPhase('submitting')
    setError(null)
    try {
      const res = await fetch(`/api/quizzes/${quizId}/attempts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      const body = await res.json()
      if (!res.ok) {
        setPhase('error')
        setError(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      setResult({ score: body.attempt.score, correctCount: body.correctCount, totalQuestions: body.totalQuestions, results: body.results })
      setPhase('done')
    } catch {
      setPhase('error')
      setError('Network error — please try again.')
    }
  }

  if (phase === 'done' && result) {
    return <ResultsView documentId={documentId} result={result} />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-sm text-muted-foreground">
        Question {index + 1} of {questions.length}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          <p className="text-lg font-medium text-card-foreground">{current.question}</p>
          <div className="flex flex-col gap-2">
            {current.options.map((option) => {
              // eslint-disable-next-line security/detect-object-injection -- see the disable above, same bounded local index
              const selected = answers[index] === option
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => selectAnswer(option)}
                  disabled={phase === 'submitting'}
                  className={cn(
                    'rounded-md border px-4 py-3 text-left text-sm transition-colors disabled:opacity-50',
                    selected ? 'border-accent bg-accent/10 text-card-foreground' : 'border-border text-card-foreground hover:bg-muted'
                  )}
                >
                  {option}
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0 || phase === 'submitting'}>
          Back
        </Button>
        <Button type="button" onClick={handleNextOrSubmit} disabled={!hasAnswered || phase === 'submitting'}>
          {phase === 'submitting' ? 'Submitting…' : isLast ? 'Submit quiz' : 'Next'}
        </Button>
      </div>
    </div>
  )
}

function ResultsView({ documentId, result }: { documentId: string; result: AttemptResult }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-3xl">{result.score}%</CardTitle>
          <CardDescription>
            {result.correctCount} of {result.totalQuestions} correct
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="flex flex-col gap-3">
        {result.results.map((r, i) => (
          <Card key={i} className={cn(r.isCorrect ? 'border-accent/40' : 'border-destructive/40')}>
            <CardContent className="flex flex-col gap-1 p-4">
              <p className="font-medium text-card-foreground">
                {i + 1}. {r.question}
              </p>
              <p className={cn('text-sm', r.isCorrect ? 'text-accent' : 'text-destructive')}>
                Your answer: {r.userAnswer || '(left blank)'} {r.isCorrect ? '✓' : '✗'}
              </p>
              {!r.isCorrect ? <p className="text-sm text-muted-foreground">Correct answer: {r.correctAnswer}</p> : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-3">
        <Link href={`/dashboard/documents/${documentId}`} className={buttonVariants({ variant: 'outline' })}>
          Back to document
        </Link>
        <Link href="/dashboard" className={buttonVariants({ variant: 'ghost' })}>
          Library
        </Link>
      </div>
    </div>
  )
}
