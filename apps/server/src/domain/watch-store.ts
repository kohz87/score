import { WatchFrameSchema, type WatchFrame } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redact, redactValue } from '../redact.ts'
import { framesForTool } from './watch-tool-frames.ts'
import type { FrameDraft, MarkerKind, Surface, ToolFrameInput } from './watch-types.ts'

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
  parent_call_id: z.string().nullable(),
})
export const FRAME_COLUMNS = 'agent_id, seq, at, run_id, surface, payload, caption, parent_call_id'

export function toFrame(row: z.infer<typeof FrameRowSchema>): WatchFrame {
  return WatchFrameSchema.parse({
    seq: row.seq,
    at: row.at,
    agentId: row.agent_id,
    runId: row.run_id,
    surface: row.surface,
    [row.surface]: JSON.parse(row.payload) as unknown,
    caption: row.caption,
    ...(row.parent_call_id ? { parentCallId: row.parent_call_id } : {}),
  })
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
    /** A coding agent's sub-agent step: the Agent call it ran under (C1). */
    parentCallId?: string | null
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
        'UPDATE watch_frames SET run_id = COALESCE(?, run_id), payload = ?, caption = ?, parent_call_id = COALESCE(?, parent_call_id) WHERE agent_id = ? AND seq = ?',
      )
      .run(
        input.runId,
        JSON.stringify(payload),
        caption,
        input.parentCallId ?? null,
        input.agentId,
        seq,
      )
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
        `INSERT INTO watch_frames (agent_id, seq, at, run_id, surface, payload, caption, marker_kind, call_key, parent_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.parentCallId ?? null,
      )
  }
  return toFrame(
    FrameRowSchema.parse(
      sqlite
        .prepare(`SELECT ${FRAME_COLUMNS} FROM watch_frames WHERE agent_id = ? AND seq = ?`)
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
  // Only browser tools read it; terminal and editor hooks must not pay for the lookup.
  const lastBrowser = input.tool.startsWith('browser_')
    ? lastBrowserFrame(sqlite, context.agentId)
    : null
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

export { FrameRowSchema }
