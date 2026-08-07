import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white p-8 text-black">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-700">
          &larr; Back to Meminno
        </Link>
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-zinc-600">Last updated: August 7, 2026</p>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">1. Where we are right now</h2>
          <p>
            Meminno hasn&apos;t launched yet. The site you&apos;re on today is a waitlist landing page, not the
            product itself. Right now, the only thing we collect is the email address you give us if you join the
            waitlist. This policy will be expanded once the actual product (document upload, AI-generated notes,
            flashcards, quizzes, and account sign-in) goes live, and we&apos;ll update the date above whenever it
            changes.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">2. Information we collect today</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Email address.</strong> If you submit the waitlist form, we store it so we can email you when
              Meminno opens up.
            </li>
            <li>
              <strong>Basic site analytics.</strong> Aggregate page-visit data (page views, referring site, coarse
              device/browser/country) collected via Vercel Analytics. This does not use cookies or an
              individually-identifying profile.
            </li>
          </ul>
          <p>We do not sell, rent, or share your email address with any third party for marketing purposes.</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">3. What we&apos;ll collect once the product launches</h2>
          <p>
            When Meminno actually launches, using the product will involve collecting more than an email address.
            Most notably, whatever coursework you choose to upload or paste (PDFs, pasted notes/text) so our AI
            (via OpenAI) can generate notes, flashcards, and quizzes from it, plus account and billing information
            if you subscribe. We&apos;ll treat that content as sensitive, since it&apos;s your own coursework, and
            we&apos;ll update this policy with the specifics (retention, deletion, exactly which third-party
            processors are involved) before that data collection begins, not after.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">4. Third-party services we use today</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Vercel.</strong> Hosts this site and provides cookieless analytics.
            </li>
            <li>
              <strong>Upstash.</strong> Stores waitlist email addresses (Redis).
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">5. Your choices</h2>
          <p>
            You can ask us to delete your email address from the waitlist at any time. Just email us at the
            address below. We&apos;ll only use it to notify you about Meminno opening up; we don&apos;t send any
            other marketing messages.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">6. Changes to this policy</h2>
          <p>
            We may update this policy as the product develops. Changes will be posted on this page with an updated
            date above.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">7. Contact us</h2>
          <p>Questions about this policy or your data? Reach us at:</p>
          <p className="font-medium">meminno.app@gmail.com</p>
        </section>
      </div>
    </main>
  );
}
