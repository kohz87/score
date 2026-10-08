// Small Myers line diff rendered as a unified diff; no dependency. Pathological inputs fall back to a
// whole-block replacement so memory stays bounded.
const MAX_EDIT_DISTANCE = 1500
const NO_EOL = '\u0000'

type Op = { kind: ' ' | '-' | '+'; line: string }

function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  else lines[lines.length - 1] += NO_EOL
  return lines
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0)
    return [
      ...a.map((line) => ({ kind: '-' as const, line })),
      ...b.map((line) => ({ kind: '+' as const, line })),
    ]
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const snapshot = trace[d]!
    const at = (k: number) => snapshot[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1]! })
      x--
      y--
    }
    if (x === prevX) ops.push({ kind: '+', line: b[y - 1]! })
    else ops.push({ kind: '-', line: a[x - 1]! })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', line: a[x - 1]! })
    x--
    y--
  }
  return ops.reverse()
}

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return [
    ...a.slice(0, start).map((line) => ({ kind: ' ' as const, line })),
    ...myers(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((line) => ({ kind: ' ' as const, line })),
  ]
}

function render(op: Op): string[] {
  if (!op.line.endsWith(NO_EOL)) return [op.kind + op.line]
  return [op.kind + op.line.slice(0, -1), '\\ No newline at end of file']
}

/** Unified diff from `before` to `after` with 3 lines of context; empty when identical. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return ''
  const ops = diffOps(toLines(before), toLines(after))
  const changed = ops.flatMap((op, index) => (op.kind === ' ' ? [] : [index]))
  if (changed.length === 0) return ''
  // Merge changes whose context windows touch into a single hunk.
  const ranges: [number, number][] = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length, index + context + 1)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  const out = ['--- current', '+++ proposed']
  for (const [from, to] of ranges) {
    let oldStart = 1
    let newStart = 1
    for (const op of ops.slice(0, from)) {
      if (op.kind !== '+') oldStart++
      if (op.kind !== '-') newStart++
    }
    const slice = ops.slice(from, to)
    const oldCount = slice.filter((op) => op.kind !== '+').length
    const newCount = slice.filter((op) => op.kind !== '-').length
    out.push(
      `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
    )
    for (const op of slice) out.push(...render(op))
  }
  return out.join('\n') + '\n'
}
