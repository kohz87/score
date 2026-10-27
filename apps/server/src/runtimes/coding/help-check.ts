import type { WorkerDeclaration } from './types.ts'

// 3.7.7 (decision 138): Score checks a new CLI version itself, from its `--help` text only. The text never leaves this
// module: the answer is which flag (if any) no longer reads as declared.

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * The help's option entries: an entry starts at a line indented by at most six spaces that begins with `-` and runs to the
 * next one, or to a line at column 0 (a section such as `Commands:`). A wrapped description can also start with a flag
 * name; such a line may be read as an entry too, which is why every entry of a flag has to pass.
 */
function entries(help: string): { names: string[]; text: string }[] {
  const found: { names: string[]; lines: string[] }[] = []
  let open = false
  for (const line of help.split(/\r?\n/)) {
    const head = /^ {1,6}(-\S.*)$/.exec(line)
    if (head) {
      const names = head[1]!
        .split(/\s{2,}/)[0]!
        .split(/[\s,]+/)
        .filter((token) => token.startsWith('-'))
      found.push({ names, lines: [head[1]!] })
      open = true
    } else if (/^\S/.test(line)) open = false
    else if (open && line.trim() !== '') found.at(-1)!.lines.push(line)
  }
  return found.map((entry) => ({ names: entry.names, text: collapse(entry.lines.join(' ')) }))
}

/** The first declared flag the help no longer documents in the declared words, or null when every one still does. */
export function helpMismatch(help: string, declaration: WorkerDeclaration['help']): string | null {
  const all = entries(help)
  for (const { flag, phrases } of declaration.flags) {
    const mine = all.filter((candidate) => candidate.names.includes(flag))
    const documents = (text: string) => phrases.every((phrase) => text.includes(collapse(phrase)))
    if (mine.length === 0 || !mine.every((entry) => documents(entry.text))) return flag
  }
  return null
}
