import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // '**/.claude/**' matters as soon as any worktree lives under
    // .claude/worktrees/ alongside the main checkout (see CLAUDE.md's
    // worktree convention) - without it, `npm test` in the main checkout
    // picks up every test file duplicated inside any sibling worktree too.
    exclude: ['**/e2e/**', '**/node_modules/**', '**/.claude/**'],
    testTimeout: 20000,
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
})
