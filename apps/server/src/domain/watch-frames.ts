import { WatchFrameSchema, type WatchFrame } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redact, redactValue } from '../redact.ts'
import { editorFramesFromTool } from './watch-diff.ts'

export const OUTPUT_BYTES = 64 * 1024
const TAIL_NOTE = '[earlier output omitted]\n'
const HIDDEN_NOTE = '[contents hidden: credential file]'

type MarkerKind = 'command' | 'file' | 'browser' | 'asked'
type Surface = WatchFrame['surface']

// Tools whose arguments or results can carry credentials. Only the tool name and status are ever kept
// (plugin and server both enforce this); the Watch view shows a plain sentence instead.
const sensitiveTool = /vault|credential|secret|passw(?:or)?d|keychain|api[_-]?key/i
export function isSensitiveTool(name: string | undefined | null): boolean {
  return typeof name === 'string' && sensitiveTool.test(name)
}

const credentialPath =
  /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(?:\.[^\\/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(?:pem|key|p12|pfx|keystore))$/i
export function isCredentialPath(path: string): boolean {
  return credentialPath.test(path)
}

const patchPaths =
  /^(?:\*\*\* (?:Update|Add|Delete) File:|\*\*\* Move to:|---|\+\+\+)\s+(?:[ab]\/)?(\S.*?)\s*$/gm
/** True when a tool's arguments name a credential file; its result and content must then not be stored (D6). */
export function touchesCredentialFile(args: unknown): boolean {
  if (args === null || typeof args !== 'object') return false
  const { path, patch } = args as { path?: unknown; patch?: unknown }
  if (typeof path === 'string' && isCredentialPath(path)) return true
  if (typeof patch !== 'string') return false
  return [...patch.slice(0, 200_000).matchAll(patchPaths)].some((m) => isCredentialPath(m[1] ?? ''))
}

export const WatchInfoSchema = z.object({
  output: z.string().optional(),
  tail: z.boolean().optional(),
  exitCode: z.int().nullish(),
  cwd: z.string().nullish(),
  // Only used by the bridge translator, which swaps it for a media id; never stored.
  screenshotPath: z.string().max(4096).optional(),
})
export type WatchInfo = z.infer<typeof WatchInfoSchema>

/** Keep the last `maxBytes` of UTF-8 text without splitting a character. */
export function tailBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false }
  const kept: string[] = []
  let size = 0
  for (const char of Array.from(text).reverse()) {
    size += Buffer.byteLength(char)
    if (size > maxBytes) break
    kept.push(char)
  }
  return { text: kept.reverse().join(''), cut: true }
}

function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    // Query strings and fragments routinely carry tokens; the replay only needs where the page is.
    return redact(
      `${url.origin === 'null' ? `${url.protocol}//` : url.origin}${url.pathname}`,
    ).slice(0, 2048)
  } catch {
    return redact(raw.split(/[?#]/, 1)[0] ?? '').slice(0, 2048)
  }
}

function host(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

const ArgsSchema = z.object({
  command: z.string().optional(),
  code: z.string().optional(),
  workdir: z.string().nullish(),
  url: z.string().optional(),
  path: z.string().optional(),
})
const ResultSchema = z.object({
  output: z.string().optional(),
  error: z.unknown().optional(),
  exit_code: z.int().nullish(),
  cwd: z.string().nullish(),
  status: z.string().optional(),
  url: z.string().optional(),
  title: z.string().nullish(),
})

export interface ToolFrameInput {
  hook: 'pre' | 'post'
  tool: string
  args: unknown
  result: unknown
  /** The bridge's tool status: running (pre), ok, error or blocked. */
  status: 'running' | 'ok' | 'error' | 'blocked'
  watch: WatchInfo | null
  lastBrowser: { url: string; title: string | null } | null
  /** Media id of this call's screenshot (browser_vision only), already stored by the bridge route. */
  screenshotMediaId?: string | null
}
export interface FrameDraft {
  suffix: string
  surface: Surface
  payload: NonNullable<WatchFrame['terminal'] | WatchFrame['editor'] | WatchFrame['browser']>
  caption: string
}

const browserCaptions: Readonly<Record<string, string>> = {
  browser_snapshot: 'Looked at the page',
  browser_click: 'Clicked on the page',
  browser_type: 'Typed into the page',
  browser_scroll: 'Scrolled the page',
  browser_back: 'Went back a page',
  browser_press: 'Pressed a key on the page',
  browser_get_images: 'Looked at the images on the page',
  browser_vision: 'Looked at the page',
  browser_console: 'Checked the page console',
}

function oneLine(text: string, max: number): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Pure: which frames one tool hook produces. Inputs have already been through the plugin's pass and `redactPayload`. */
export function framesForTool(input: ToolFrameInput): FrameDraft[] {
  const { hook, tool, status } = input
  if (tool.startsWith('browser_vault_') || (tool.startsWith('browser_') && isSensitiveTool(tool))) {
    if (hook === 'pre') return []
    return [
      {
        suffix: '',
        surface: 'browser',
        payload: {
          url: input.lastBrowser?.url ?? '',
          title: input.lastBrowser?.title ?? null,
          imageUrl: null,
        },
        caption: tool === 'browser_vault_fill' ? 'Filled a saved login' : 'Used the password vault',
      },
    ]
  }
  if (isSensitiveTool(tool)) return []
  const args = ArgsSchema.safeParse(input.args ?? {})
  const result = ResultSchema.safeParse(
    input.result !== null && typeof input.result === 'object' ? input.result : {},
  )
  const a = args.success ? args.data : {}
  const r = result.success ? result.data : {}
  if (tool === 'terminal' || tool === 'execute_code') {
    const command = (tool === 'terminal' ? a.command : a.code) ?? ''
    const watch = input.watch
    let output = watch?.output ?? r.output ?? ''
    if (typeof output !== 'string') output = ''
    const clipped = tailBytes(output, OUTPUT_BYTES - TAIL_NOTE.length)
    const marked = watch?.tail || clipped.cut ? TAIL_NOTE + clipped.text : clipped.text
    const exitCode = watch?.exitCode ?? r.exit_code ?? null
    const failed =
      status === 'error' ||
      status === 'blocked' ||
      (exitCode !== null && exitCode !== 0) ||
      (r.error !== undefined && r.error !== null && r.error !== false && r.error !== '') ||
      r.status === 'error' ||
      r.status === 'timeout'
    const done = hook === 'post'
    return [
      {
        suffix: '',
        surface: 'terminal',
        payload: {
          cwd: watch?.cwd ?? r.cwd ?? a.workdir ?? '',
          command,
          output: done ? marked : '',
          status: !done ? 'running' : failed ? 'error' : 'ok',
        },
        caption:
          tool === 'terminal'
            ? command.trim()
              ? `Ran ${oneLine(command, 60)}`
              : 'Ran a command'
            : 'Ran a script',
      },
    ]
  }
  if (tool === 'write_file' || tool === 'patch') {
    if (hook === 'pre' || status !== 'ok') return []
    return editorFramesFromTool(tool, input.args, input.result).map((frame, index) => {
      const hidden = isCredentialPath(frame.path)
      return {
        suffix: index === 0 ? '' : `#${index}`,
        surface: 'editor' as const,
        payload: hidden ? { ...frame, diff: HIDDEN_NOTE } : frame,
        caption: `${tool === 'write_file' ? 'Wrote' : 'Edited'} ${frame.path}`,
      }
    })
  }
  if (tool.startsWith('browser_')) {
    if (hook === 'pre') return []
    const url = r.url ?? a.url ?? input.lastBrowser?.url ?? ''
    const known = host(url)
    return [
      {
        suffix: '',
        surface: 'browser',
        payload: {
          url,
          title: r.title ?? input.lastBrowser?.title ?? null,
          imageUrl:
            tool === 'browser_vision' && input.screenshotMediaId
              ? `/api/media/${input.screenshotMediaId}`
              : null,
        },
        caption:
          tool === 'browser_navigate'
            ? known
              ? `Opened ${known}`
              : 'Opened a page'
            : (browserCaptions[tool] ?? 'Used the browser'),
      },
    ]
  }
  return []
}

const markerFor: Record<Surface, MarkerKind> = {
  terminal: 'command',
  editor: 'file',
  browser: 'browser',
}

const FrameRowSchema = z.object({
  agent_id: z.string(),
  seq: z.int().positive(),
  at: z.iso.datetime(),
  run_id: z.string().nullable(),
  surface: z.enum(['terminal', 'editor', 'browser']),
  payload: z.string(),
  caption: z.string(),
})

function toFrame(row: z.infer<typeof FrameRowSchema>): WatchFrame {
  return WatchFrameSchema.parse({
    seq: row.seq,
    at: row.at,
    agentId: row.agent_id,
    runId: row.run_id,
    surface: row.surface,
    [row.surface]: JSON.parse(row.payload) as unknown,
    caption: row.caption,
  })
}

/**
 * Second redaction pass (D6 layer 2): every string is scrubbed here, at the single storage point,
 * so no producer path can skip it. Browser URLs also lose their query and fragment.
 */
function scrubPayload(frame: Pick<FrameDraft, 'surface' | 'payload' | 'caption'>): {
  payload: FrameDraft['payload']
  caption: string
} {
  let payload = redactValue(frame.payload) as FrameDraft['payload']
  if (frame.surface === 'browser') {
    const browser = payload as NonNullable<WatchFrame['browser']>
    payload = {
      url: sanitizeUrl(browser.url),
      title: browser.title === null ? null : redact(browser.title).slice(0, 300),
      imageUrl: browser.imageUrl,
    }
  }
  return { payload, caption: redact(frame.caption).slice(0, 200) }
}

export function recordFrame(
  sqlite: DatabaseSync,
  input: {
    agentId: string
    runId: string | null
    at: string
    callKey: string | null
    surface: Surface
    payload: FrameDraft['payload']
    caption: string
    marker?: MarkerKind
  },
): WatchFrame {
  const { payload, caption } = scrubPayload(input)
  const existing = input.callKey
    ? sqlite
        .prepare('SELECT seq FROM watch_frames WHERE agent_id = ? AND call_key = ?')
        .get(input.agentId, input.callKey)
    : undefined
  let seq: number
  if (existing) {
    seq = z.object({ seq: z.int().positive() }).parse(existing).seq
    sqlite
      .prepare(
        'UPDATE watch_frames SET run_id = COALESCE(?, run_id), payload = ?, caption = ? WHERE agent_id = ? AND seq = ?',
      )
      .run(input.runId, JSON.stringify(payload), caption, input.agentId, seq)
  } else {
    seq =
      z
        .object({ seq: z.int().nonnegative() })
        .parse(
          sqlite
            .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM watch_frames WHERE agent_id = ?')
            .get(input.agentId),
        ).seq + 1
    sqlite
      .prepare(
        `INSERT INTO watch_frames (agent_id, seq, at, run_id, surface, payload, caption, marker_kind, call_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.agentId,
        seq,
        input.at,
        input.runId,
        input.surface,
        JSON.stringify(payload),
        caption,
        input.marker ?? markerFor[input.surface],
        input.callKey,
      )
  }
  return toFrame(
    FrameRowSchema.parse(
      sqlite
        .prepare(
          'SELECT agent_id, seq, at, run_id, surface, payload, caption FROM watch_frames WHERE agent_id = ? AND seq = ?',
        )
        .get(input.agentId, seq),
    ),
  )
}

export function lastBrowserFrame(
  sqlite: DatabaseSync,
  agentId: string,
): { url: string; title: string | null } | null {
  const row = sqlite
    .prepare(
      'SELECT payload FROM watch_frames WHERE agent_id = ? AND surface = \'browser\' AND payload NOT LIKE \'%"url":""%\' ORDER BY seq DESC LIMIT 1',
    )
    .get(agentId)
  if (!row) return null
  const parsed = z
    .object({ url: z.string(), title: z.string().nullable() })
    .safeParse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload))
  return parsed.success ? parsed.data : null
}

export function runIdForSession(
  sqlite: DatabaseSync,
  profile: string,
  sessionId: string | null,
): string | null {
  if (!sessionId) return null
  const row = sqlite
    .prepare(
      'SELECT id FROM runs WHERE profile = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(profile, sessionId)
  return row ? z.object({ id: z.string() }).parse(row).id : null
}

const MEDIA_URL = /^\/api\/media\/([0-9a-f-]{36})$/
export function mediaIdOf(imageUrl: string | null | undefined): string | null {
  return imageUrl ? (MEDIA_URL.exec(imageUrl)?.[1] ?? null) : null
}

// A frame that shows an image holds one reference, so the media quota sweep keeps it; retention releases it.
function retainFrameImage(
  sqlite: DatabaseSync,
  draft: FrameDraft,
  context: { agentId: string; at: string; sessionId: string | null; toolCallId: string | null },
  mediaId: string | null | undefined,
): void {
  if (draft.surface !== 'browser') return
  const browser = draft.payload as NonNullable<WatchFrame['browser']>
  if (!mediaId || mediaIdOf(browser.imageUrl) !== mediaId) return
  const key = context.toolCallId
    ? `${context.sessionId ?? ''}:${context.toolCallId}${draft.suffix}`
    : null
  // A redelivered hook rewrites the same frame; it must not take a second reference.
  const prior = key
    ? sqlite
        .prepare('SELECT payload FROM watch_frames WHERE agent_id = ? AND call_key = ?')
        .get(context.agentId, key)
    : undefined
  if (
    prior &&
    mediaIdOf(
      (JSON.parse(String((prior as { payload: unknown }).payload)) as { imageUrl?: string })
        .imageUrl,
    ) === mediaId
  )
    return
  const changed = sqlite
    .prepare('UPDATE media SET refs = refs + 1, last_used_at = ? WHERE id = ?')
    .run(context.at, mediaId).changes
  if (Number(changed) === 0) browser.imageUrl = null
}

/** Frames for one bridge tool hook, stored in the caller's transaction. */
export function recordToolFrames(
  sqlite: DatabaseSync,
  context: {
    agentId: string
    at: string
    sessionId: string | null
    toolCallId: string | null
  },
  input: Omit<ToolFrameInput, 'lastBrowser'>,
): WatchFrame[] {
  const lastBrowser = lastBrowserFrame(sqlite, context.agentId)
  const drafts = framesForTool({ ...input, lastBrowser })
  for (const draft of drafts) retainFrameImage(sqlite, draft, context, input.screenshotMediaId)
  const runId = runIdForSession(sqlite, context.agentId, context.sessionId)
  return drafts.map((draft) =>
    recordFrame(sqlite, {
      agentId: context.agentId,
      runId,
      at: context.at,
      callKey: context.toolCallId
        ? `${context.sessionId ?? ''}:${context.toolCallId}${draft.suffix}`
        : null,
      surface: draft.surface,
      payload: draft.payload,
      caption: draft.caption,
    }),
  )
}

export interface WatchPage {
  frames: WatchFrame[]
  markers: { seq: number; at: string; kind: MarkerKind }[]
}

export function readWatch(
  sqlite: DatabaseSync,
  agentId: string,
  { from, limit }: { from?: number | undefined; limit: number },
): WatchPage {
  const rows = z.array(FrameRowSchema).parse(
    from === undefined
      ? sqlite
          .prepare(
            `SELECT agent_id, seq, at, run_id, surface, payload, caption FROM
               (SELECT * FROM watch_frames WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
          )
          .all(agentId, limit)
      : sqlite
          .prepare(
            `SELECT agent_id, seq, at, run_id, surface, payload, caption FROM watch_frames
             WHERE agent_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
          )
          .all(agentId, from, limit),
  )
  const markers = z
    .array(
      z.object({
        seq: z.int().positive(),
        at: z.iso.datetime(),
        kind: z.enum(['command', 'file', 'browser', 'asked']),
      }),
    )
    .parse(
      sqlite
        .prepare(
          `SELECT seq, at, marker_kind AS kind FROM watch_frames
           WHERE agent_id = ? AND marker_kind IS NOT NULL ORDER BY seq DESC LIMIT 2000`,
        )
        .all(agentId),
    )
    .reverse()
  // A question for the human lands on the nearest earlier frame, so scrubbing to it shows what was on screen.
  const asked = z.array(z.object({ at: z.iso.datetime() })).parse(
    sqlite
      .prepare(
        `SELECT created_at AS at FROM approvals WHERE profile = ? AND visible = 1
           ORDER BY created_at DESC LIMIT 200`,
      )
      .all(agentId),
  )
  for (const { at } of asked) {
    const near = sqlite
      .prepare(
        'SELECT seq FROM watch_frames WHERE agent_id = ? AND at <= ? ORDER BY seq DESC LIMIT 1',
      )
      .get(agentId, at)
    if (near) markers.push({ seq: z.object({ seq: z.int() }).parse(near).seq, at, kind: 'asked' })
  }
  markers.sort((x, y) => x.seq - y.seq || x.at.localeCompare(y.at))
  return { frames: rows.map(toFrame), markers }
}

export function isLive(sqlite: DatabaseSync, agentId: string): boolean {
  return (
    sqlite
      .prepare(
        "SELECT 1 FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') LIMIT 1",
      )
      .get(agentId) !== undefined
  )
}
