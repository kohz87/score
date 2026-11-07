export function Headline({
  label,
  value,
  detail,
  stat,
}: {
  label: string
  value: string
  detail: string
  stat: string
}) {
  return (
    <div className="card usage-stat" data-stat={stat}>
      <span className="small muted">{label}</span>
      <b>{value}</b>
      <span className="small muted">{detail}</span>
    </div>
  )
}
