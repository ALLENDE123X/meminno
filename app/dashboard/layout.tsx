import { SiteHeader } from '@/components/site-header'

// MEM-008: shared shell for every /dashboard/* route (library, stats,
// per-document workspace, quiz-taking) — one place for the nav header
// instead of every page re-implementing it. Each page underneath still
// does its own getSessionUser() check and renders its own sign-in prompt
// when unauthenticated (matching app/dashboard/stats/page.tsx's existing
// convention) rather than this layout redirecting — SiteHeader itself
// already degrades correctly for a signed-out visitor (a plain "Sign in"
// link instead of the full nav), so an unauthenticated hit on any
// /dashboard/* route still renders a coherent page, not a broken shell.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      {children}
    </div>
  )
}
