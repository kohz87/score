import { defineConfig } from 'vitest/config'

// Tests and the e2e server read times as UTC whatever zone the machine is set to (the VM moved to GMT+8 on 2026-10-28,
// and times rendered in the local zone broke tests written against UTC). Workers and the web server inherit it.
process.env.TZ = 'UTC'

export default defineConfig({
  test: {
    setupFiles: [
      './test/helpers/tmp-root.ts',
      './test/helpers/default-host.ts',
      './test/helpers/wait-defaults.ts',
    ],
    // Heavy suites share the machine with the web tests and other work: 5 s is a fast machine's budget, not a bug's.
    testTimeout: 20_000,
    // expect.poll defaults to 1 s: far too short for a loaded machine. Polls return at the first success.
    expect: { poll: { timeout: 20_000 } },
  },
})
