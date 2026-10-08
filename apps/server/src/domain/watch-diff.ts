// V4A semantics adapted from NousResearch/hermes-agent tools/patch_parser.py; Copyright (c) 2025 Nous Research (MIT).
import type { WatchFrame } from '@score/contract'
import { z } from 'zod'
import { unifiedDiff } from './line-diff.ts'

export type EditorFrame = NonNullable<WatchFrame['editor']>

const MAX_DIFF_BYTES = 64 * 1024
// These controls signal binary data; tabs and line endings remain valid text.
// eslint-disable-next-line no-control-regex
const binaryControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const TextSchema = z.string().refine((text) => !binaryControls.test(text) && text.isWellFormed())
const PathSchema = TextSchema.max(4096).refine((path) => !!path.trim() && !/[\r\n\t]/u.test(path))
const WriteSchema = z.object({ path: PathSchema, content: TextSchema })
const ReplaceSchema = z.object({
  mode: z.literal('replace').optional(),
  path: PathSchema,
  old_string: TextSchema.refine((text) => text.length > 0),
  new_string: TextSchema,
  replace_all: z.boolean().optional(),
})
const PatchSchema = z.object({
  mode: z.literal('patch'),
  path: PathSchema.optional(),
  patch: TextSchema,
})
const ResultSchema = z.object({
  diff: TextSchema.optional(),
  error: z.string().nullable().optional(),
  success: z.boolean().optional(),
  no_change: z.boolean().optional(),
})
const languages: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
}

type FileDiff = { path: string; header: string; hunks: string[] }
type Hunk = { hint: string; lines: string[] }
type Operation = { kind: string; path: string; destination?: string; hunks: Hunk[] }

const normalize = (text: string) => text.replace(/\r\n/g, '\n')
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')
const lineCount = (text: string) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
const headers = (before: string, after: string) => `--- ${before}\n+++ ${after}\n`

function computed(path: string, before: string, after: string, fragment = false): FileDiff {
  const diff = unifiedDiff(normalize(before), normalize(after))
  const body = diff.split('\n').slice(2).join('\n')
  return {
    path,
    header: diff ? headers(path, path) : '',
    hunks: body
      ? body
          .split(/(?=^@@ )/m)
          .filter(Boolean)
          .map((hunk) =>
            fragment ? hunk.replace(/ @@\n/u, ' @@ fragment (file position unknown)\n') : hunk,
          )
      : [],
  }
}

function capDiff(file: FileDiff): string {
  const totalLines = file.hunks.reduce((sum, hunk) => sum + lineCount(hunk), 0)
  let includedLines = 0
  let diff = file.header
  for (const hunk of file.hunks) {
    const nextLines = includedLines + lineCount(hunk)
    const marker = nextLines < totalLines ? `… ${totalLines - nextLines} more lines\n` : ''
    if (byteLength(diff) + byteLength(hunk) + byteLength(marker) > MAX_DIFF_BYTES) break
    diff += hunk
    includedLines = nextLines
  }
  if (includedLines < totalLines) diff += `… ${totalLines - includedLines} more lines\n`
  return diff
}

function frames(files: FileDiff[]): EditorFrame | EditorFrame[] | null {
  // Multiple operations on one path still occupy one editor pane.
  const grouped = new Map<string, FileDiff>()
  for (const file of files) {
    const existing = grouped.get(file.path)
    if (existing) {
      if (!existing.header) existing.header = file.header
      if (file.header && file.header !== existing.header) {
        existing.hunks.push(file.header + (file.hunks[0] ?? ''))
        existing.hunks.push(...file.hunks.slice(1))
      } else existing.hunks.push(...file.hunks)
    } else grouped.set(file.path, { ...file, hunks: [...file.hunks] })
  }
  const result = [...grouped.values()].map((file) => {
    const name = file.path.split(/[/\\]/u).at(-1) ?? ''
    const extension = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
    return {
      path: file.path,
      diff: capDiff(file),
      language: Object.hasOwn(languages, extension) ? languages[extension]! : null,
    }
  })
  return result.length === 0 ? null : result.length === 1 ? result[0]! : result
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!
  const path: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw
  const parsed = PathSchema.safeParse(path)
  return parsed.success ? parsed.data : null
}

function parseUnified(text: string, fallbackPath?: string): FileDiff[] | null {
  const lines = normalize(text).split('\n')
  const files: FileDiff[] = []
  let file: FileDiff | undefined
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      let oldPath = headerPath(line)
      let newPath = headerPath(lines[i + 1]!)
      if (!oldPath || !newPath || (oldPath === '/dev/null' && newPath === '/dev/null')) return null
      if (
        (oldPath.startsWith('a/') || oldPath === '/dev/null') &&
        (newPath.startsWith('b/') || newPath === '/dev/null')
      ) {
        if (oldPath !== '/dev/null') oldPath = oldPath.slice(2)
        if (newPath !== '/dev/null') newPath = newPath.slice(2)
      }
      const path = newPath === '/dev/null' ? oldPath : newPath
      if (!PathSchema.safeParse(path).success) return null
      file = { path, header: headers(oldPath, newPath), hunks: [] }
      files.push(file)
      i += 2
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line)
    if (hunk) {
      if (!file && fallbackPath) {
        file = { path: fallbackPath, header: headers(fallbackPath, fallbackPath), hunks: [] }
        files.push(file)
      }
      if (!file) return null
      let oldLeft = Number(hunk[2] ?? 1)
      let newLeft = Number(hunk[4] ?? 1)
      if (
        ![hunk[1], hunk[2] ?? 1, hunk[3], hunk[4] ?? 1].every((value) =>
          Number.isSafeInteger(Number(value)),
        )
      )
        return null
      const body = [line]
      i++
      while (oldLeft > 0 || newLeft > 0) {
        const content = lines[i++]
        if (content === undefined) return null
        if (content === '\\ No newline at end of file' && body.length > 1) {
          body.push(content)
          continue
        }
        if (!/^[ +-]/u.test(content)) return null
        if (content[0] !== '+') oldLeft--
        if (content[0] !== '-') newLeft--
        if (oldLeft < 0 || newLeft < 0) return null
        body.push(content)
      }
      if (lines[i] === '\\ No newline at end of file') body.push(lines[i++]!)
      file.hunks.push(body.join('\n') + '\n')
      continue
    }
    if (line && !/^(?:diff --git |index |(?:new|deleted) file mode |(?:old|new) mode )/u.test(line))
      return null
    i++
  }
  return files.length && files.every((entry) => entry.hunks.length) ? files : null
}

function parseOperations(text: string): Operation[] | null {
  const operations: Operation[] = []
  let operation: Operation | undefined
  let hunk: Hunk | undefined
  let ended = false
  for (const line of normalize(text).split('\n')) {
    if (ended) {
      if (line.trim()) return null
      continue
    }
    if (/^\*\*\*\s*Begin\s+Patch\s*$/u.test(line)) {
      if (operations.length) return null
      continue
    }
    if (/^\*\*\*\s*End\s+Patch\s*$/u.test(line)) {
      ended = true
      continue
    }
    const header = /^\*\*\*\s*(Update|Add|Delete|Move)\s+File:\s*(.+)$/u.exec(line)
    if (header) {
      const kind = header[1]!
      const paths = kind === 'Move' ? header[2]!.split(/\s+->\s+/u) : [header[2]!]
      if (
        paths.length !== (kind === 'Move' ? 2 : 1) ||
        !paths.every((path) => PathSchema.safeParse(path.trim()).success)
      )
        return null
      operation = { kind, path: paths[0]!.trim(), destination: paths[1]?.trim(), hunks: [] }
      operations.push(operation)
      hunk = undefined
      continue
    }
    if (line.startsWith('***')) return null
    if (!line) continue
    if (!operation || operation.kind === 'Delete' || operation.kind === 'Move') return null
    if (line.startsWith('@@')) {
      hunk = {
        hint: line
          .slice(2)
          .replace(/\s*@@\s*$/u, '')
          .trim(),
        lines: [],
      }
      operation.hunks.push(hunk)
    } else if (line !== '\\ No newline at end of file') {
      if (!hunk) {
        hunk = { hint: '', lines: [] }
        operation.hunks.push(hunk)
      }
      if (operation.kind === 'Add' && !line.startsWith('+')) return null
      hunk.lines.push(/^[ +-]/u.test(line) ? line : ' ' + line)
    }
  }
  return operations.length &&
    operations.every((op) => op.kind !== 'Update' || op.hunks.some((h) => h.lines.length))
    ? operations
    : null
}

function replace(before: string, oldText: string, newText: string, all = false): string | null {
  const index = before.indexOf(oldText)
  if (index < 0 || (!all && before.indexOf(oldText, index + 1) >= 0)) return null
  return all
    ? before.split(oldText).join(newText)
    : before.slice(0, index) + newText + before.slice(index + oldText.length)
}

function operationDiffs(operations: Operation[], previous?: string | null): FileDiff[] | null {
  const files: FileDiff[] = []
  // Use a baseline only when it unambiguously describes one operation.
  const known = operations.length === 1 && previous != null ? normalize(previous) : null
  for (const operation of operations) {
    const { path, kind, hunks } = operation
    if (kind === 'Move') {
      files.push({
        path: operation.destination!,
        header: `diff --git ${path} ${operation.destination}\nsimilarity index 100%\nrename from ${path}\nrename to ${operation.destination}\n`,
        hunks: [],
      })
    } else if (kind === 'Delete') {
      const file = computed(path, known ?? '', '')
      file.header = headers(path, '/dev/null')
      if (known === null) file.header += '# Previous content unavailable\n'
      files.push(file)
    } else if (kind === 'Add') {
      // V4A joins add lines without appending a final newline.
      const file = computed(
        path,
        '',
        hunks.flatMap((h) => h.lines.map((line) => line.slice(1))).join('\n'),
      )
      file.header = headers('/dev/null', path)
      files.push(file)
    } else if (known !== null) {
      let after = known
      for (const hunk of hunks) {
        const beforeText = hunk.lines
          .filter((line) => line[0] !== '+')
          .map((line) => line.slice(1))
          .join('\n')
        const afterText = hunk.lines
          .filter((line) => line[0] !== '-')
          .map((line) => line.slice(1))
          .join('\n')
        if (beforeText === afterText) continue
        if (!beforeText) {
          if (!hunk.hint) after = after.replace(/\n+$/u, '') + '\n' + afterText + '\n'
          else {
            const index = after.indexOf(hunk.hint)
            if (index < 0 || after.indexOf(hunk.hint, index + 1) >= 0) return null
            const end = after.indexOf('\n', index)
            const at = end < 0 ? after.length : end + 1
            after =
              after.slice(0, at) +
              (end < 0 ? '\n' : '') +
              afterText +
              (end < 0 ? '' : '\n') +
              after.slice(at)
          }
        } else {
          const replaced = replace(after, beforeText, afterText)
          if (replaced === null) return null
          after = replaced
        }
      }
      files.push(computed(path, known, after))
    } else {
      const file: FileDiff = { path, header: headers(path, path), hunks: [] }
      for (const hunk of hunks) {
        const beforeText = hunk.lines
          .filter((line) => line[0] !== '+')
          .map((line) => line.slice(1))
          .join('\n')
        const afterText = hunk.lines
          .filter((line) => line[0] !== '-')
          .map((line) => line.slice(1))
          .join('\n')
        file.hunks.push(...computed(path, beforeText, afterText, true).hunks)
      }
      files.push(file)
    }
  }
  return files
}

/** Pure editor payload builder. Redact inputs before calling; no file contents are read here. */
export function editorFrameFromTool(
  tool: string,
  args: unknown,
  result: unknown,
  previous?: string | null,
): EditorFrame | EditorFrame[] | null {
  try {
    if (tool !== 'write_file' && tool !== 'patch') return null
    if (previous != null && !TextSchema.safeParse(previous).success) return null
    const outcome = ResultSchema.safeParse(
      typeof result === 'string' ? JSON.parse(result) : (result ?? {}),
    )
    if (
      !outcome.success ||
      outcome.data.error ||
      outcome.data.success === false ||
      outcome.data.no_change
    )
      return null
    if (tool === 'write_file') {
      const parsed = WriteSchema.safeParse(args)
      return parsed.success
        ? frames([computed(parsed.data.path, previous ?? '', parsed.data.content)])
        : null
    }
    const patch = PatchSchema.safeParse(args)
    const replacement = ReplaceSchema.safeParse(args)
    if (!patch.success && !replacement.success) return null
    if (outcome.data.diff) {
      const files = parseUnified(outcome.data.diff)
      if (files) return frames(files)
    }
    if (patch.success) {
      const files = parseUnified(patch.data.patch, patch.data.path)
      if (files) return frames(files)
      const operations = parseOperations(patch.data.patch)
      const normalized = operations && operationDiffs(operations, previous)
      return normalized ? frames(normalized) : null
    }
    if (!replacement.success) return null
    const { path, old_string: oldText, new_string: newText, replace_all: all } = replacement.data
    if (previous == null) return frames([computed(path, oldText, newText, true)])
    const before = normalize(previous)
    const after = replace(before, normalize(oldText), normalize(newText), all)
    return after === null ? null : frames([computed(path, before, after)])
  } catch {
    // Includes malformed JSON results/quoted diff headers and hostile getters in unknown inputs.
    return null
  }
}

/** Editor frames for one tool call: always an array (a multi-file patch yields several; nothing to show yields none). */
export function editorFramesFromTool(
  tool: string,
  args: unknown,
  result: unknown,
  previous?: string | null,
): EditorFrame[] {
  const frames = editorFrameFromTool(tool, args, result, previous)
  return frames === null ? [] : Array.isArray(frames) ? frames : [frames]
}
