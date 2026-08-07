import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Meminno — Upload your coursework, get notes, flashcards, quizzes",
  description: "Upload or paste your coursework and get AI-generated notes, flashcards, and quizzes in minutes.",
  metadataBase: new URL("https://meminno.com"),
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
