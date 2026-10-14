import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { UpdateCheckSchema, type UpdateCheck } from '@score/contract'

/** What the update check needs from the network; tests pass their own, so they never touch it. */
export type UpdateFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const TagsSchema = z.array(z.object({ name: z.string() }).loose())
const MIN_GAP_MS = 60_000
export const UPDATE_TIMEOUT_MS = 10_000

export function parseTag(tag: string): [number, number, number] | null {
  const match = TAG.exec(tag)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The repo root: this file is apps/server/src/domain/about.ts. */
export const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

let commit: Promise<string | null> | undefined
/** Short commit of the running checkout, read once with git (argument array, never a shell); null if not a checkout. */
export function readCommit(
  run: (cwd: string) => Promise<string> = (cwd) =>
    new Promise((ok, fail) =>
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 5000 }, (error, stdout) =>
        error ? fail(error) : ok(stdout),
      ),
    ),
): Promise<string | null> {
  commit ??= run(CHECKOUT).then(
    (out) => out.trim() || null,
    () => null,
  )
  return commit
}

export interface UpdateCheckerOptions {
  repo: string
  version: string
  fetcher: UpdateFetcher
  clock?: () => number
  timeoutMs?: number
}

const UNAVAILABLE = 'Couldn’t reach GitHub. Check your connection and try again.'

/** One check per minute: a call inside that window gets the last answer back, so a double click costs one request. */
export function createUpdateChecker({
  repo,
  version,
  fetcher,
  clock = Date.now,
  timeoutMs = UPDATE_TIMEOUT_MS,
}: UpdateCheckerOptions): () => Promise<UpdateCheck> {
  let last: { at: number; answer: Promise<UpdateCheck> } | undefined
  const answer = (status: UpdateCheck['status'], message: string, tag?: string): UpdateCheck => {
    const base = `https://github.com/${repo}`
    return UpdateCheckSchema.parse({
      checkedAt: new Date(clock()).toISOString(),
      current: version,
      status,
      latest: tag
        ? {
            version: tag.slice(1),
            tag,
            url: `${base}/releases/tag/${tag}`,
            changelogUrl: `${base}/blob/${tag}/CHANGELOG.md`,
          }
        : null,
      message,
    })
  }
  async function run(): Promise<UpdateCheck> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Score/${version}` },
        signal: controller.signal,
      })
      if (!response.ok) return answer('unavailable', UNAVAILABLE)
      const tags = TagsSchema.parse(await response.json())
      let best: { tag: string; parts: [number, number, number] } | undefined
      for (const { name } of tags) {
        const parts = parseTag(name)
        if (parts && (!best || compareVersions(parts, best.parts) > 0)) best = { tag: name, parts }
      }
      if (!best) return answer('unavailable', 'Couldn’t find a released version to compare with.')
      const current = parseTag(`v${version}`)
      if (!current) return answer('unavailable', UNAVAILABLE)
      const order = compareVersions(best.parts, current)
      if (order > 0) return answer('update_available', `${best.tag} is available.`, best.tag)
      if (order < 0)
        return answer('ahead', 'This build is newer than the latest release.', best.tag)
      return answer('up_to_date', `You’re up to date (v${version}).`, best.tag)
    } catch {
      return answer('unavailable', UNAVAILABLE)
    } finally {
      clearTimeout(timer)
    }
  }
  return () => {
    if (last && clock() - last.at < MIN_GAP_MS) return last.answer
    const next = { at: clock(), answer: run() }
    last = next
    return next.answer
  }
}
