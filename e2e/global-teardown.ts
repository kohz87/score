import { rmSync } from 'node:fs'

// Removes the run folder (server homes, logs, temp folders) that playwright.config.ts created under /tmp.
export default function globalTeardown(): void {
  const dir = process.env.SCORE_E2E_HOME
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
