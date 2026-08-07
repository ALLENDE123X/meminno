This is a [Next.js](https://nextjs.org) project bootstrapped with `create-next-app`, scaffolded to mirror the proven [Propinno](https://github.com/ALLENDE123X/propinno) stack (Next.js App Router + TypeScript, Drizzle ORM, Supabase/Postgres, Vercel, Inngest, Stripe).

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Database

Schema lives in `lib/db/schema.ts`. Generate and apply migrations with:

```bash
npm run db:generate   # drizzle-kit generate — writes SQL into drizzle/
npm run db:migrate    # drizzle-kit migrate — applies pending migrations against DATABASE_URL
```

## Learn More

See `CLAUDE.md` in the repo root for the operating model, hard stops, and ticket/PR protocol for this project.
