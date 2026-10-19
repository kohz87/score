export type PortraitCrop = { x: number; y: number; side: number }

/** Alpha above this counts as the character (anti-aliasing fringes and stray faint pixels do not). */
const OPAQUE = 16
const SIDE = 0.45

/**
 * The square around a pet's head (PLAN 10.8): horizontally centred, its top at the top of the character's visible
 * pixels, as wide as 45% of the frame's height. A frame with nothing visible falls back to the top 45%.
 */
export function portraitCrop(rgba: Uint8ClampedArray, width: number, height: number): PortraitCrop {
  const side = Math.min(width, height * SIDE)
  let top = 0
  scan: for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (rgba[(y * width + x) * 4 + 3]! > OPAQUE) {
        top = y
        break scan
      }
  return { x: (width - side) / 2, y: Math.min(top, height - side), side }
}
