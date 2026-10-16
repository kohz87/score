import type { CodingModelOption, CodingModelsResponse, CodingRuntime } from '@score/contract'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

// Model lists for the coding agent form (PLAN 8.5, decision 86). Each list comes from the CLI's own source without a
// prompt; nothing else from those sources is read or kept.

/** The same shape the agent's `model` field accepts (CodingAgentCreateSchema), so an offered id is always savable. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/
const none = (): CodingModelsResponse => ({ models: [], source: 'none' })

/** `agy models` (1.3.6): one `id<TAB>name` line per model. Anything that isn't that shape is dropped. */
export function parseAntigravityModels(output: string): CodingModelOption[] {
  const seen = new Set<string>()
  const models: CodingModelOption[] = []
  for (const line of output.split('\n')) {
    const cells = line.trimEnd().split('\t')
    const id = cells[0]?.trim()
    const name = cells[1]?.trim()
    if (cells.length !== 2 || !id || !name || id.length > 200 || name.length > 200) continue
    if (!SAFE_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name })
    if (models.length >= 200) break
  }
  return models
}

/** Claude Code has no listing command, and a bare word after `claude` runs a prompt: the documented aliases only. */
export const CLAUDE_CODE_ALIASES: CodingModelOption[] = [
  { id: 'fable', name: 'Fable', description: 'Claude’s most capable model.' },
  { id: 'opus', name: 'Opus', description: 'The latest Opus model.' },
  { id: 'sonnet', name: 'Sonnet', description: 'The latest Sonnet model.' },
]

// Only these fields are ever read from Codex's cache. The file also holds an account identity: it is never parsed
// into anything (zod strips unknown keys) and never returned or logged.
const CodexCache = z.object({
  models: z.array(
    z.object({
      slug: z.string().max(200),
      display_name: z.string().max(200).optional(),
      description: z.string().max(2000).nullish(),
      visibility: z.string().max(40).nullish(),
      supported_reasoning_levels: z
        .array(z.union([z.string().max(40), z.object({ effort: z.string().max(40) })]))
        .max(12)
        .optional(),
    }),
  ),
})

export function parseCodexModels(text: string): CodingModelOption[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const parsed = CodexCache.safeParse(json)
  if (!parsed.success) return []
  const seen = new Set<string>()
  const models: CodingModelOption[] = []
  for (const entry of parsed.data.models) {
    if (entry.visibility && entry.visibility !== 'list') continue
    if (!SAFE_ID.test(entry.slug) || seen.has(entry.slug)) continue
    seen.add(entry.slug)
    const efforts = (entry.supported_reasoning_levels ?? [])
      .map((level) => (typeof level === 'string' ? level : level.effort))
      .filter((level) => level.length > 0)
    const description = entry.description?.trim().slice(0, 500)
    models.push({
      id: entry.slug,
      name: entry.display_name?.trim() || entry.slug,
      ...(description ? { description } : {}),
      ...(efforts.length ? { efforts } : {}),
    })
    if (models.length >= 200) break
  }
  return models
}

const CACHE_MAX_BYTES = 2 * 1024 * 1024

/**
 * `$CODEX_HOME/models_cache.json` (default `~/.codex`): a regular file owned by this user, opened with O_NOFOLLOW and
 * capped in size. Only that one file is opened; `auth.json` and everything else next to it stay untouched.
 */
export function readCodexModels(codexHome: string | undefined): CodingModelsResponse {
  const path = join(
    codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex'),
    'models_cache.json',
  )
  let fd: number | null = null
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > CACHE_MAX_BYTES)
      return none()
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.ino !== before.ino || stat.size > CACHE_MAX_BYTES) return none()
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < stat.size) {
      const count = readSync(fd, buffer, read, stat.size - read, read)
      if (count === 0) break
      read += count
    }
    const models = parseCodexModels(buffer.subarray(0, read).toString('utf8'))
    return models.length ? { models, source: 'cache' } : none()
  } catch {
    return none()
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export const aliasModels = (runtime: CodingRuntime): CodingModelsResponse | null =>
  runtime === 'claude-code' ? { models: CLAUDE_CODE_ALIASES, source: 'aliases' } : null
