/**
 * Stop, as an icon (owner, 2026-10-27): a red rounded square, a fixed colour with a thin white edge (a theme can't hide
 * it, even on a red ground; the buttons are protected surfaces). The button around it carries the "Stop" name.
 */
export function StopIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="stop-icon">
      <rect
        x="1"
        y="1"
        width="12"
        height="12"
        rx="3.5"
        fill="#d64545"
        stroke="#ffffff"
        strokeWidth="1"
      />
    </svg>
  )
}
