// Colour maths for the theme engine: parses the colour forms a theme may use (contract ThemeColorSchema) and
// measures WCAG contrast, so a pair that fails AA on a protected surface can fall back to Score's own colours.
export type Rgba = readonly [number, number, number, number]

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function numberOf(part: string, percentScale: number): number {
  const trimmed = part.trim()
  if (trimmed.endsWith('%')) return (Number.parseFloat(trimmed) / 100) * percentScale
  return Number.parseFloat(trimmed)
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12
    return l - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [channel(0), channel(8), channel(4)]
}

function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  const encode = (v: number) => {
    const x = clamp01(v)
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  }
  return [encode(lin[0] ?? 0), encode(lin[1] ?? 0), encode(lin[2] ?? 0)]
}

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()` and `oklch()`; null for anything else. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)
  if (hex?.[1]) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1]
    const byte = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16) / 255
    return [byte(0), byte(2), byte(4), digits.length === 8 ? byte(6) : 1]
  }
  const fn = /^(rgba?|hsla?|oklch)\(([^)]*)\)$/.exec(text)
  if (!fn?.[1] || fn[2] === undefined) return null
  const parts = fn[2]
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const alpha = parts[3] === undefined ? 1 : clamp01(numberOf(parts[3], 1))
  let rgb: [number, number, number]
  if (fn[1].startsWith('rgb')) {
    rgb = [0, 1, 2].map((i) => clamp01(numberOf(parts[i] ?? '0', 255) / 255)) as [
      number,
      number,
      number,
    ]
  } else if (fn[1].startsWith('hsl')) {
    rgb = hslToRgb(
      Number.parseFloat(parts[0] ?? '0'),
      clamp01(numberOf(parts[1] ?? '0', 1)),
      clamp01(numberOf(parts[2] ?? '0', 1)),
    )
  } else {
    rgb = oklchToRgb(
      clamp01(numberOf(parts[0] ?? '0', 1)),
      Math.max(0, numberOf(parts[1] ?? '0', 0.4)),
      Number.parseFloat(parts[2] ?? '0'),
    )
  }
  if (rgb.some((v) => Number.isNaN(v)) || Number.isNaN(alpha)) return null
  return [rgb[0], rgb[1], rgb[2], alpha]
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Lays a translucent colour over an opaque one. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3]
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ]
}

/** WCAG 2 contrast ratio of text over a background (the text is composited over it when translucent). */
export function contrastRatio(text: Rgba, background: Rgba): number {
  const bg = over(background, [1, 1, 1, 1])
  const fg = over(text, bg)
  const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}
