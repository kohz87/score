/** Splits a tool-server command like a shell would for quoting, but never runs it through one. */
export type ParsedToolCommand = { ok: true; argv: string[] } | { ok: false; error: string }

export function parseToolCommand(input: string): ParsedToolCommand {
  const argv: string[] = []
  let current = ''
  let quoted: '"' | "'" | null = null
  let started = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quoted === "'") {
      if (character === "'") quoted = null
      else current += character
      started = true
      continue
    }
    if (quoted === '"') {
      if (character === '"') {
        quoted = null
        started = true
      } else if (character === '\\' && index + 1 < input.length) {
        current += input[index + 1]!
        index += 1
      } else current += character
      continue
    }
    if (character === "'" || character === '"') {
      quoted = character
      started = true
      continue
    }
    if (character === '\\' && index + 1 < input.length) {
      current += input[index + 1]!
      index += 1
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }

  if (quoted) return { ok: false, error: 'Close the quote in the command.' }
  if (started) argv.push(current)
  if (argv.length === 0) return { ok: false, error: 'Type a command to run.' }
  return { ok: true, argv }
}
