import { editorFramesFromTool } from './watch-diff.ts'
import { z } from 'zod'
import { OUTPUT_BYTES, tailBytes } from './watch-output.ts'
import { isCredentialPath, isSensitiveTool } from './watch-sensitive.ts'
import type { FrameDraft, ToolFrameInput } from './watch-types.ts'

const TAIL_NOTE = '[earlier output omitted]\n'
const HIDDEN_NOTE = '[contents hidden: credential file]'

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

function host(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
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
