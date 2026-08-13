import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LandingPodcastPreview } from "@/components/landing-podcast-preview";

const FEATURES = [
  {
    title: "AI-generated notes",
    description: "Upload a PDF or paste your coursework and get clean, organized study notes in minutes.",
  },
  {
    title: "Flashcards, built for you",
    description: "Every set of notes turns into a ready-to-study flashcard deck, already made for you.",
  },
  {
    title: "Quiz yourself instantly",
    description: "Auto-generated quizzes pulled straight from your own material, so you know what you actually know.",
  },
  {
    title: "Your weekly stat card",
    description:
      "A shareable card that sums up your week (cards reviewed, quizzes taken, streaks), so the work you put in is easy to actually see.",
    badge: "New",
  },
];

// MEM-018 (issue #88): the podcast feature's own selling points. Kept as a
// const array alongside FEATURES/STEPS rather than inlined in the JSX, so
// the section below reads the same way every other section on this page does.
const PODCAST_POINTS = [
  {
    title: "Study while you're doing something else",
    description:
      "Put it on for the walk to class, the gym, the bus, the dishes. Time you were never going to spend reading anyway becomes review time.",
  },
  {
    title: "Dense material, explained out loud",
    description:
      "One host walks through your material, the other asks the questions you'd actually ask. Hearing a hard idea get unpacked in conversation sticks better than re-reading the same paragraph.",
  },
  {
    title: "Made from your material, not a generic episode",
    description:
      "It's generated from the exact PDF, notes, or lecture recording you uploaded, so it covers your class and your professor's emphasis, not somebody else's syllabus.",
  },
];

const STEPS = [
  {
    step: "1",
    title: "Upload, paste, or record",
    description: "Lecture slides, a textbook chapter, your own typed notes, or a live recording of the lecture itself.",
  },
  {
    step: "2",
    title: "Get notes, flashcards, a quiz, and a podcast",
    description: "Meminno's AI reads your material and generates all four, organized and ready to study.",
  },
  {
    step: "3",
    title: "Track your week, share it",
    description: "See your progress add up and share a clean stat card when you want to show your friends (or yourself) the work is happening.",
  },
];

export default function Home() {
  return (
    // Forced light theme regardless of the app's new default dark/sky-blue
    // theme (MEM-008): components/ui/card.tsx and button.tsx now read
    // dark-charcoal/sky-blue CSS custom properties from app/globals.css by
    // default (the app-wide theme from here on), but this page was
    // deliberately shipped forced-light (MEM-010, its original comment
    // here) and isn't in MEM-008's explicit retrofit list (/upload,
    // /dashboard/stats) — a marketing-site redesign is a separate decision
    // from wiring up the in-app dark theme. `theme-light` (see
    // app/globals.css) scopes the *original* light token values back onto
    // this subtree so Card/Button render exactly as before, instead of
    // silently inheriting dark-on-dark from the new global default.
    <main className="theme-light flex min-h-screen flex-col bg-white text-black">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <span className="text-lg font-semibold tracking-tight">Meminno</span>
        <Link href="/sign-in" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Sign in
        </Link>
      </header>

      {/* Hero */}
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-16 text-center sm:py-24">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Turn your coursework into notes, flashcards, and quizzes, automatically.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-zinc-600">
          Upload a PDF or paste your notes, and Meminno&apos;s AI does the rest, plus builds a shareable stat card
          that tracks your study streak, so you can actually see the work paying off.
        </p>
        <div className="mt-10 flex w-full max-w-md flex-col items-center gap-3">
          <Link href="/sign-in" className={buttonVariants({ className: "w-full" })}>
            Get started free
          </Link>
          <p className="text-sm text-zinc-500">Start free. No credit card required.</p>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          Everything you need to actually study
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle>{feature.title}</CardTitle>
                  {feature.badge ? (
                    <span className="rounded-full bg-black px-2 py-0.5 text-xs font-medium text-white">
                      {feature.badge}
                    </span>
                  ) : null}
                </div>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* Podcast (MEM-018, issue #88) — deliberately its own section rather
          than a fifth card in the FEATURES grid above: it's the newest and
          most demo-able thing the product does, and a grid cell can't show
          what an Audio Overview actually sounds like. Placed here, between
          the features overview and "How it works", so the page still reads
          overview → depth → process → price. */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <div className="flex flex-col items-center text-center">
          <span className="rounded-full bg-black px-3 py-1 text-xs font-medium text-white">New</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
            Turn any reading into a podcast you can listen to
          </h2>
          <p className="mt-3 max-w-2xl text-zinc-600">
            Meminno turns your uploaded coursework into an AI-generated conversation between two hosts, who talk
            through your material the way a good study partner would. About five minutes, ready to play, made from
            whatever you just uploaded.
          </p>
        </div>

        <div className="mt-10 grid items-center gap-10 lg:grid-cols-2">
          <LandingPodcastPreview />
          <div className="flex flex-col gap-6">
            {PODCAST_POINTS.map((point) => (
              <div key={point.title} className="flex flex-col gap-1.5">
                <h3 className="font-semibold">{point.title}</h3>
                <p className="text-sm text-zinc-600">{point.description}</p>
              </div>
            ))}
            <Link href="/sign-in" className={buttonVariants({ className: "self-start" })}>
              Make your first podcast
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.step} className="flex flex-col items-start gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black text-sm font-semibold text-white">
                {s.step}
              </span>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="text-sm text-zinc-600">{s.description}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-center text-sm text-zinc-500">
          Upload a PDF, paste your notes, or record a lecture live right in your browser.
        </p>
      </section>

      {/* Pricing */}
      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">Simple, student pricing</h2>
        <p className="mt-3 text-center text-zinc-600">
          Free to start. Upgrade whenever you actually need more.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Free</CardTitle>
              <CardDescription>Try it out with a capped amount of uploads and generations each month.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">$0</p>
              <Link href="/sign-in" className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}>
                Start free
              </Link>
            </CardContent>
          </Card>
          <Card className="border-black">
            <CardHeader>
              <CardTitle>Monthly</CardTitle>
              <CardDescription>Higher monthly limits for notes, flashcards, and quizzes, billed every month.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">
                $17.99<span className="text-base font-normal text-zinc-500">/mo</span>
              </p>
              <Link href="/billing" className={buttonVariants({ className: "mt-4 w-full" })}>
                Subscribe
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Semester</CardTitle>
              <CardDescription>Same as monthly, paid once per semester, at the best per-month price.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">
                $59.99<span className="text-base font-normal text-zinc-500">/4 months</span>
              </p>
              <Link href="/billing" className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}>
                Subscribe
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Ready to study smarter?</h2>
        <p className="mt-3 max-w-lg text-zinc-600">
          Sign in with your email and start uploading in under a minute. No credit card required for the free plan.
        </p>
        <div className="mt-8">
          <Link href="/sign-in" className={buttonVariants({ size: "lg" })}>
            Get started free
          </Link>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-5xl flex-col items-center gap-2 px-6 py-10 text-center text-sm text-zinc-500">
        <span>© {new Date().getFullYear()} Meminno. Built for students.</span>
        <Link href="/privacy" className="underline hover:text-zinc-700">
          Privacy Policy
        </Link>
      </footer>
    </main>
  );
}
