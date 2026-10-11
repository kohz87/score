import { fromMarkdown } from 'mdast-util-from-markdown'

/** Code and inline-code ranges from a real CommonMark parse (test oracle only; too slow for the server). */
export function oracleCodeRanges(text: string): Array<[number, number]> {
  const found: Array<[number, number]> = []
  const stack: unknown[] = [fromMarkdown(text)]
  while (stack.length > 0) {
    const node = stack.pop() as {
      type: string
      position?: { start: { offset?: number }; end: { offset?: number } }
      children?: unknown[]
    }
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) found.push([start, end])
      continue
    }
    if (node.children) stack.push(...node.children)
  }
  return found
}
