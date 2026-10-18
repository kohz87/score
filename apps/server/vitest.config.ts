import { defineConfig } from 'vitest/config'

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
