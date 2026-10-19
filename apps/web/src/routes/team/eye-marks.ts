import type { AvatarEyes } from '@score/contract'

type Box = AvatarEyes['left']
export type EyeSide = 'left' | 'right'

/** Where the boxes start: two small boxes on the upper middle of the picture, ready to be dragged onto the eyes. */
export const defaultEyes: Pick<AvatarEyes, 'left' | 'right'> = {
  left: { x: 0.26, y: 0.38, w: 0.18, h: 0.12 },
  right: { x: 0.56, y: 0.38, w: 0.18, h: 0.12 },
}

/** The eyelid colour when nothing could be sampled (a fully transparent band): a neutral skin tone. */
export const fallbackLid = '#D9B8A0'

const MIN = 0.02

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

/** The box moved by a fraction of the picture, kept inside it. */
export function moveBox(box: Box, dx: number, dy: number): Box {
  return {
    ...box,
    x: clamp(box.x + dx, 0, 1 - box.w),
    y: clamp(box.y + dy, 0, 1 - box.h),
  }
}

/** The box with its far corner moved (it grows right and down), kept inside the picture and at least 2% each way. */
export function resizeBox(box: Box, dw: number, dh: number): Box {
  return {
    ...box,
    w: clamp(box.w + dw, MIN, 1 - box.x),
    h: clamp(box.h + dh, MIN, 1 - box.y),
  }
}

type Pixels = { width: number; height: number; data: ArrayLike<number> }

/**
 * The eyelid colour for one picture: the average of a thin band just below each box (the skin under the eye),
 * counting only pixels that are mostly opaque. A band that runs off the picture is cut; with nothing to sample
 * the neutral fallback is used.
 */
export function sampleLid(pixels: Pixels, boxes: readonly Box[]): string {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (const box of boxes) {
    const left = Math.max(0, Math.floor(box.x * pixels.width))
    const right = Math.min(
      pixels.width,
      Math.max(left + 1, Math.ceil((box.x + box.w) * pixels.width)),
    )
    const bottom = (box.y + box.h) * pixels.height
    const band = Math.max(2, 0.3 * box.h * pixels.height)
    const top = Math.max(0, Math.floor(bottom))
    const end = Math.min(pixels.height, Math.max(top + 1, Math.ceil(bottom + band)))
    for (let y = top; y < end; y += 1)
      for (let x = left; x < right; x += 1) {
        const at = (y * pixels.width + x) * 4
        if ((pixels.data[at + 3] ?? 0) < 128) continue
        r += pixels.data[at] ?? 0
        g += pixels.data[at + 1] ?? 0
        b += pixels.data[at + 2] ?? 0
        count += 1
      }
  }
  if (count === 0) return fallbackLid
  const hex = (sum: number) =>
    Math.round(sum / count)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase()
}
