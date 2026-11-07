import { join } from 'node:path'
import { home, root, webOrigin } from './config.ts'
import { run } from './process.ts'

export interface WebResult {
  label: string
  route: string
  renderMs: number
  longTasks: number
  maxLongTaskMs: number
}

export async function webCheck(
  label: string,
  cookie: string,
): Promise<{ ok: boolean; output: string }> {
  const [name, value] = cookie.split('=') as [string, string]
  try {
    const { stdout } = await run(
      join(root, 'node_modules/.bin/playwright'),
      ['test', '-c', 'scripts/perf/playwright.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          PERF_BASE_URL: webOrigin,
          PERF_COOKIE_NAME: name,
          PERF_COOKIE_VALUE: value,
          PERF_LABEL: label,
          PERF_OUT: join(home, 'web-perf.jsonl'),
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    return { ok: true, output: stdout }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}
