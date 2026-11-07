import type { GraphNode } from './orch-model.ts'

/** The outline of a local node, drawn behind its text: a diamond for a gate, a hexagon for a branch, a pill otherwise. */
export function NodeShape({
  shape,
  w,
  h,
}: {
  shape: NonNullable<GraphNode['shape']>
  w: number
  h: number
}) {
  const inset = 2
  const points =
    shape === 'gate'
      ? `${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`
      : shape === 'branch'
        ? `${h / 3},${inset} ${w - h / 3},${inset} ${w - inset},${h / 2} ${w - h / 3},${h - inset} ${h / 3},${h - inset} ${inset},${h / 2}`
        : null
  return (
    <svg
      className="orch-node__shape"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      focusable="false"
    >
      {points ? (
        <polygon points={points} strokeLinejoin="round" />
      ) : (
        <rect
          x={inset}
          y={inset}
          width={w - inset * 2}
          height={h - inset * 2}
          rx={shape === 'end' ? (h - inset * 2) / 2 : 14}
        />
      )}
    </svg>
  )
}
