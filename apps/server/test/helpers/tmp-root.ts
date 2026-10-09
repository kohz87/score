import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Test hygiene: every test file gets its own TMPDIR, so each mkdtemp/tmpdir() use (in tests, in the code under test,
// and in child processes, which inherit the env) lands in one folder that is removed when the file finishes, pass or
// fail. Individual tests may still clean up earlier; this is the backstop.
const root = mkdtempSync(join(tmpdir(), 'score-test-root-'))
process.env.TMPDIR = root

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
