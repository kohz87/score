import { existsSync, readFileSync } from 'node:fs'
import { afterEach } from 'vitest'
import { startHarness, type Harness, type HarnessOptions } from '../helpers/coding-harness.ts'

export const harnesses: Harness[] = []

export function setupSupervisorTestLifecycle() {
  afterEach(async () => {
    for (const h of harnesses.splice(0)) {
      await h.server.shutdown()
      await Promise.race([h.done, new Promise((r) => setTimeout(r, 5000))])
      // Survivors this test's CLIs recorded: its own processes, never anything else.
      if (existsSync(h.cgroup.survivorsFile)) h.cgroup.killPayload()
    }
  })
}

export async function run(options: HarnessOptions, drive?: (h: Harness) => Promise<void>) {
  const h = await startHarness(options)
  harnesses.push(h)
  await h.session.ready
  await drive?.(h)
  if (!drive) h.session.go()
  const outcome = await h.outcome
  const code = await h.done
  return { h, outcome, code }
}

export const json = (file: string) =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
