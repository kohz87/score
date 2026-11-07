/** The quiet part of a line between two nodes; dots run along it only while work flows into the layer below. */
export function Line({
  active,
  still,
  dashed,
  horizontal,
  label,
}: {
  active?: boolean
  still: boolean
  dashed?: boolean
  horizontal?: boolean
  label?: string
}) {
  return (
    <span
      className="jobmap-line"
      data-dashed={dashed ? '' : undefined}
      data-horizontal={horizontal ? '' : undefined}
      aria-hidden="true"
    >
      {label && <span className="jobmap-line-label">{label}</span>}
      {active && !still && <span className="jobmap-dot" />}
    </span>
  )
}
