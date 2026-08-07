import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Meminno — Turn your coursework into notes, flashcards, and quizzes",
  description:
    "Upload a PDF or paste your notes and Meminno's AI builds your study notes, flashcards, and a quiz in minutes — plus a shareable weekly progress card.",
  // No custom domain purchased yet — this must stay the real deployed URL
  // (not a hardcoded future domain) until one is bought. See CLAUDE.md.
  metadataBase: new URL("https://meminno.vercel.app"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={geist.className}>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
