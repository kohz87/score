import { vi } from 'vitest'

// Waits end when their condition holds, so a long timeout costs nothing on a pass; it only decides how long a loaded
// machine gets before a wait is called a failure. vitest's default for vi.waitFor is 1 s, which a busy machine
// overruns on conditions that are only a few milliseconds of work when idle. (expect.poll is set in vitest.config.ts.)
const DEFAULT_WAIT_MS = 20_000
const waitFor = vi.waitFor.bind(vi) as typeof vi.waitFor
vi.waitFor = ((
  callback: Parameters<typeof vi.waitFor>[0],
  options?: number | { timeout?: number; interval?: number },
) =>
  waitFor(
    callback,
    typeof options === 'number' ? options : { timeout: DEFAULT_WAIT_MS, ...options },
  )) as typeof vi.waitFor
