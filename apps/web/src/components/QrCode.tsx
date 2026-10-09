import qrcode from 'qrcode-generator'

/** Rows of dark modules as one SVG path: a run of dark cells per row becomes one rectangle. */
export function qrPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  let path = ''
  for (let row = 0; row < count; row++) {
    let col = 0
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col++
        continue
      }
      const start = col
      while (col < count && qr.isDark(row, col)) col++
      path += `M${start} ${row}h${col - start}v1h-${col - start}z`
    }
  }
  return { size: count, path }
}

const QUIET = 4

/** Inline SVG QR code, black on white whatever the theme (scanners need contrast). The URL is not repeated for
 * screen readers: the link is already on the page as text. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = qrPath(text)
  const total = size + QUIET * 2
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path transform={`translate(${QUIET} ${QUIET})`} d={path} fill="#000" />
    </svg>
  )
}
