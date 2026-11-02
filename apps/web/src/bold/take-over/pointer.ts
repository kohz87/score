// Pointer maths for the take-over screen (3.17.0): client coordinates to screen pixels, DOM buttons to the RFB mask.

export const WHEEL_UP = 8
export const WHEEL_DOWN = 16

type Box = { left: number; top: number; width: number; height: number }

/** The position in screen pixels, clamped into the screen. */
export function toScreenPoint(
  clientX: number,
  clientY: number,
  rect: Box,
  width: number,
  height: number,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max - 1)
  return {
    x: clamp(Math.floor(((clientX - rect.left) * width) / rect.width), width),
    y: clamp(Math.floor(((clientY - rect.top) * height) / rect.height), height),
  }
}

/** DOM `buttons` (left 1, right 2, middle 4) to the RFB mask (left 1, middle 2, right 4). */
export function rfbButtons(domButtons: number): number {
  return (domButtons & 1 ? 1 : 0) | (domButtons & 4 ? 2 : 0) | (domButtons & 2 ? 4 : 0)
}

export type PointerInput = { k: 'pointer'; x: number; y: number; buttons: number }

/** A wheel notch is a press and a release of the wheel button. */
export function wheelNotch(x: number, y: number, up: boolean, held = 0): PointerInput[] {
  return [
    { k: 'pointer', x, y, buttons: held | (up ? WHEEL_UP : WHEEL_DOWN) },
    { k: 'pointer', x, y, buttons: held },
  ]
}

/** A click: move, press, release. */
export function click(x: number, y: number, button: 1 | 4): PointerInput[] {
  return [
    { k: 'pointer', x, y, buttons: 0 },
    { k: 'pointer', x, y, buttons: button },
    { k: 'pointer', x, y, buttons: 0 },
  ]
}
