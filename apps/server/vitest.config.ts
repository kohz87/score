import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./test/helpers/tmp-root.ts', './test/helpers/default-host.ts'],
    // Heavy suites share the machine with the web tests and other work: 5 s is a fast machine's budget, not a bug's.
    testTimeout: 20_000,
  },
})
