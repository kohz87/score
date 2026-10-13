import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Test hygiene: every test file gets its own TMPDIR, so each mkdtemp/tmpdir() use (in tests, in the code under test,
// and in child processes, which inherit the env) lands in one folder that is removed when the file finishes, pass or
// fail. Individual tests may still clean up earlier; this is the backstop.
const root = mkdtempSync(join(tmpdir(), 'score-test-root-'))
process.env.TMPDIR = root
// Never the real state folder: the execution journal, its provenance record and locks default to
// $XDG_STATE_HOME/score, so every test (and every child process) gets a private one. A test that needs a specific
// journal folder still sets SCORE_JOURNAL_DIR itself.
process.env.XDG_STATE_HOME = join(root, 'state')
delete process.env.SCORE_JOURNAL_DIR
// Coding runs on the host's real systemd user manager only where a test asks for it (the opt-in suites build their own
// UnitBackend): a server started by a test never probes or starts a unit.
process.env.SCORE_CODING_BACKEND = 'process-group'

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
