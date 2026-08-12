import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white p-8 text-black">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-700">
          &larr; Back to Meminno
        </Link>
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-zinc-600">Last updated: August 11, 2026</p>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">1. Where we are right now</h2>
          <p>
            Meminno&apos;s core product &mdash; account sign-in, uploading or pasting your coursework,
            AI-generated notes, flashcards, and quizzes, live lecture recording and transcription, and a paid
            subscription plan &mdash; is live. This policy covers what we collect from using it, as well as
            anything still on file from our earlier waitlist signups.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">2. Information we collect</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Email address.</strong> The email address tied to your account, or one you gave us if you
              joined our waitlist.
            </li>
            <li>
              <strong>Basic site analytics.</strong> Aggregate page-visit data (page views, referring site, coarse
              device/browser/country) collected via Vercel Analytics. This does not use cookies or an
              individually-identifying profile.
            </li>
            <li>
              <strong>Coursework you upload or paste.</strong> The text of the PDFs you upload or the text you
              paste directly &mdash; we extract and store that text, not the original PDF file &mdash; used to
              generate your notes, flashcards, and quizzes.
            </li>
            <li>
              <strong>Microphone audio.</strong> If you use live lecture recording, the audio captured from your
              microphone, used to transcribe your lecture into text. See &ldquo;How AI processes your
              content&rdquo; below for exactly where this data goes.
            </li>
            <li>
              <strong>Subscription and billing status.</strong> Whether you have an active paid subscription and
              which plan. Your payment card details are entered directly with Stripe and are never seen by
              Meminno &mdash; see the third-party services section below.
            </li>
          </ul>
          <p>We do not sell, rent, or share your personal information with any third party for marketing purposes.</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">3. How AI processes your content</h2>
          <p>
            Some of Meminno&apos;s features work by sending your content to third-party AI providers. Specifically:
          </p>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>OpenAI.</strong> When you generate notes, flashcards, or a quiz from a document, the text of
              that document is sent to OpenAI to produce them. If you use the optional AI podcast feature, the
              text of that document is also sent to OpenAI to write the podcast script. When you use live lecture
              recording, the raw audio captured from your microphone is sent to OpenAI to transcribe it into text
              &mdash; that raw audio is not stored by us afterward, only the resulting transcript is saved as your
              document.
            </li>
            <li>
              <strong>Google (Gemini).</strong> If you use the optional AI podcast feature, the podcast script
              &mdash; which OpenAI generates from your document, as described above &mdash; is sent to
              Google&apos;s Gemini to be turned into audio. Gemini does not receive your original document.
            </li>
          </ul>
          <p>
            Each provider processes this content under its own privacy policy and terms of service. We only send
            your content to these providers to perform the specific task described above &mdash; generating your
            notes, flashcards, quiz, transcript, or podcast script/audio &mdash; not for any other purpose of our
            own.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">4. Third-party services we use</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>
              <strong>Vercel.</strong> Hosts this site and provides cookieless analytics.
            </li>
            <li>
              <strong>Upstash.</strong> Stores waitlist email addresses and helps enforce usage limits (Redis).
            </li>
            <li>
              <strong>Supabase.</strong> Stores your account and product data (documents, notes, flashcards,
              quizzes).
            </li>
            <li>
              <strong>OpenAI.</strong> Processes coursework text (to generate notes, flashcards, quizzes, and
              podcast scripts) and microphone audio (to transcribe live lecture recordings). See &ldquo;How AI
              processes your content&rdquo; above for detail.
            </li>
            <li>
              <strong>Google (Gemini).</strong> For the optional AI podcast feature, turns the
              OpenAI-generated podcast script into audio. See &ldquo;How AI processes your content&rdquo; above
              for detail.
            </li>
            <li>
              <strong>Stripe.</strong> Processes subscription payments.
            </li>
          </ul>
          <p>Each of these services has its own privacy policy governing how it handles your data.</p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">5. Your choices</h2>
          <p>
            You can ask us to delete your email address from the waitlist at any time. Just email us at the
            address below. We&apos;ll only use it to notify you about Meminno; we don&apos;t send any other
            marketing messages.
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
