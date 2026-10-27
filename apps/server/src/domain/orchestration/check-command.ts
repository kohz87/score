// 3.13 (decision 150): the oracle's command line. The person types one line; it becomes an argument array without a
// shell. Quotes and backslashes group words; anything a shell would interpret is refused rather than passed on literally,
// so nobody is surprised that `a && b` didn't chain. A shell is still possible, written out: bash -lc '…'.

import { ORCH_CHECK_LIMITS } from '@score/contract'

export type SplitResult = { ok: true; argv: string[] } | { ok: false; reason: string }

const SHELL_ONLY = new Set([
  '|',
  '&',
  ';',
  '<',
  '>',
  '$',
  '`',
  '*',
  '?',
  '(',
  ')',
  '{',
  '}',
  '~',
  '#',
  '!',
])

export function splitCommand(line: string): SplitResult {
  const text = line.trim()
  if (text === '') return { ok: false, reason: 'Type a command to run.' }
  if (text.length > ORCH_CHECK_LIMITS.commandChars)
    return { ok: false, reason: 'That command is too long.' }
  if (/[\r\n\0]/.test(text)) return { ok: false, reason: 'Keep the command on one line.' }
  const argv: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < text.length && '"\\'.includes(text[i + 1]!)) word += text[++i]
      else if (c === '$' || c === '`') return { ok: false, reason: shellReason(c) }
      else word += c
      continue
    }
    if (c === ' ' || c === '\t') {
      if (inWord) argv.push(word)
      word = ''
      inWord = false
      continue
    }
    inWord = true
    if (c === "'" || c === '"') quote = c
    else if (c === '\\') {
      if (i + 1 >= text.length)
        return { ok: false, reason: 'The command ends with a lone backslash.' }
      word += text[++i]
    } else if (SHELL_ONLY.has(c) && !(c === '#' && word !== '') && !(c === '~' && word !== ''))
      return { ok: false, reason: shellReason(c) }
    else word += c
  }
  if (quote) return { ok: false, reason: 'A quote is never closed.' }
  if (inWord) argv.push(word)
  if (argv.length > ORCH_CHECK_LIMITS.maxArgs)
    return { ok: false, reason: `Use at most ${ORCH_CHECK_LIMITS.maxArgs} words.` }
  return { ok: true, argv }
}

function shellReason(c: string): string {
  return `“${c}” needs a shell. Score runs the command without one; to use a shell, write it out: bash -lc '…'.`
}

/** The argv as one line again, quoting what needs it (for the lead's input and the job page). */
export function joinCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}
