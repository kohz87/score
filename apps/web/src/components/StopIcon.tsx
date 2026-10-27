/** Stop, as an icon (owner, 2026-10-27): a red rounded square. The button around it carries the "Stop" name. */
export function StopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="stop-icon">
      <rect x="1" y="1" width="12" height="12" rx="3.5" fill="var(--bad, #d64545)" />
    </svg>
  )
}
