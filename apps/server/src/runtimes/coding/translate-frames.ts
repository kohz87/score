import type { WatchFrame } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { framesForTool, recordFrame, type FrameDraft } from '../../domain/watch-frames.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import type { ToolDetail } from './types.ts'
import type { RunTranslation } from './translate-types.ts'

function frameDrafts(
  sqlite: DatabaseSync,
  translation: RunTranslation,
  callKey: string,
  at: string,
  draft: FrameDraft,
  parentCallId: string | null = null,
): DomainEventDraft[] {
  try {
    const frame: WatchFrame = recordFrame(sqlite, {
      agentId: translation.agentId,
      runId: translation.runId,
      at,
      callKey: `${translation.runId}:${callKey}${draft.suffix}`,
      surface: draft.surface,
      payload: draft.payload,
      // A sub-agent's frames say so (PLAN 8.7) and, since C1, name the Agent call; the caption prefix serves older readers.
      caption: parentCallId ? `Sub-agent · ${draft.caption}` : draft.caption,
      parentCallId,
    })
    return [{ type: 'watch.frame', data: frame }]
  } catch (error) {
    // The replay is best effort: a frame that fails validation must not stop the run.
    console.error('Coding watch frame skipped', error)
    return []
  }
}

/** Watch frames come from the same parsed events (D6): Hermes-shaped tool inputs feed the same frame builders. */
export function framesFor(
  sqlite: DatabaseSync,
  translation: RunTranslation,
  callId: string,
  at: string,
  detail: ToolDetail,
  phase: { hook: 'pre' } | { hook: 'post'; ok: boolean; output: string; exitCode: number | null },
  parentCallId: string | null = null,
): DomainEventDraft[] {
  const base = { watch: null, status: phase.hook === 'pre' ? ('running' as const) : null }
  if (detail.type === 'command') {
    const post = phase.hook === 'post'
    const drafts = framesForTool({
      hook: phase.hook,
      tool: 'terminal',
      args: { command: redact(detail.command), workdir: detail.cwd ?? '' },
      result: post ? { output: phase.output, exit_code: phase.exitCode } : {},
      status: post ? (phase.ok ? 'ok' : 'error') : 'running',
      watch: base.watch,
      lastBrowser: null,
    })
    return drafts.flatMap((draft) =>
      frameDrafts(sqlite, translation, callId, at, draft, parentCallId),
    )
  }
  if (detail.type === 'file') {
    if (phase.hook === 'pre') return []
    const verb = { add: 'Added', update: 'Edited', delete: 'Deleted' }[detail.change]
    return frameDrafts(
      sqlite,
      translation,
      callId,
      at,
      {
        suffix: '',
        surface: 'editor',
        payload: { path: detail.path, diff: `${verb} ${detail.path}`, language: null },
        caption: `${verb} ${detail.path}`,
      },
      parentCallId,
    )
  }
  if (detail.type === 'browser') {
    if (phase.hook === 'pre') return []
    return framesForTool({
      hook: 'post',
      tool: detail.url ? 'browser_navigate' : 'browser_snapshot',
      args: { url: detail.url ?? '' },
      result: {},
      status: phase.ok ? 'ok' : 'error',
      watch: null,
      lastBrowser: null,
    }).flatMap((draft) => frameDrafts(sqlite, translation, callId, at, draft, parentCallId))
  }
  if (phase.hook === 'pre') return []
  if (!phase.ok) return []
  const tool = detail.type === 'write' ? 'write_file' : 'patch'
  const args =
    detail.type === 'write'
      ? { path: detail.path, content: redact(detail.content) }
      : {
          mode: 'replace',
          path: detail.path,
          old_string: redact(detail.oldString),
          new_string: redact(detail.newString),
        }
  return framesForTool({
    hook: 'post',
    tool,
    args,
    result: {},
    status: 'ok',
    watch: null,
    lastBrowser: null,
  }).flatMap((draft) => frameDrafts(sqlite, translation, callId, at, draft, parentCallId))
}
