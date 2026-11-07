import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

export const BULLET = /^(\s*)([-*+])\s+(?!\[[ xX]\]\s)/
export const TASK = /^(\s*)[-*+]\s+\[[ xX]\]\s+/
export const NUMBERED = /^(\s*)\d+[.)]\s+/
export const QUOTE = /^(\s*)>\s?/
export const HEADING = /^(#{1,6})\s+/

// ---- what is under the caret -------------------------------------------------------------------------------------

export function ancestorNamed(
  state: EditorState,
  pos: number,
  names: string[],
  side: -1 | 1 = -1,
): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, side)
  while (node) {
    if (names.includes(node.name)) return node
    node = node.parent
  }
  return null
}

/** A block (table, code) that contains the caret, also when the caret is right at its first character. */
export const blockNamed = (state: EditorState, pos: number, names: string[]) =>
  ancestorNamed(state, pos, names) ?? ancestorNamed(state, pos, names, 1)

// ---- line formats ------------------------------------------------------------------------------------------------

export function selectedLines(state: EditorState) {
  const doc = state.doc
  const seen = new Set<number>()
  const lines = []
  for (const range of state.selection.ranges) {
    const first = doc.lineAt(range.from).number
    let last = doc.lineAt(range.to).number
    // A selection that ends at the start of a line does not include that line.
    if (!range.empty && range.to === doc.line(last).from && last > first) last -= 1
    for (let n = first; n <= last; n += 1) {
      if (seen.has(n)) continue
      seen.add(n)
      lines.push(doc.line(n))
    }
  }
  return lines
}

export function calloutHeaderAbove(state: EditorState, lineNumber: number): number | null {
  for (let n = lineNumber; n >= 1; n -= 1) {
    const text = state.doc.line(n).text
    if (!QUOTE.test(text)) return null
    if (/^\s*(?:>\s?)+\[![A-Za-z]+\]/.test(text)) return n
  }
  return null
}
