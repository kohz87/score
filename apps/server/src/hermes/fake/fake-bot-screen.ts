import type { BotScreenStatus } from '@score/contract'
import { encodePng } from '../live/bot-screen.ts'

// The demo team's Bot Desktop (3.3.0): builder has a screen running, drawn here — a desktop with a browser window
// whose progress bar moves once a second, so the live view visibly updates. Everyone else's screen is off.

const WIDTH = 960
const HEIGHT = 600
const cache = new Map<number, Buffer>()

function fill(fb: Uint8Array, x: number, y: number, w: number, h: number, rgb: readonly number[]) {
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) fb.set(rgb, (row * WIDTH + col) * 4)
}

function draw(seq: number): Buffer {
  const fb = new Uint8Array(WIDTH * HEIGHT * 4)
  fill(fb, 0, 0, WIDTH, HEIGHT, [38, 44, 58])
  fill(fb, 0, HEIGHT - 32, WIDTH, 32, [24, 26, 34]) // panel
  fill(fb, 80, 60, 800, 460, [244, 245, 248]) // window
  fill(fb, 80, 60, 800, 36, [222, 225, 232]) // title bar
  fill(fb, 120, 120, 520, 18, [205, 210, 220]) // address bar
  for (let line = 0; line < 6; line++)
    fill(fb, 120, 170 + line * 34, 680 - line * 60, 14, [214, 218, 226])
  const progress = 40 + ((seq * 37) % 640)
  fill(fb, 120, 420, 680, 16, [226, 230, 238])
  fill(fb, 120, 420, progress, 16, [52, 199, 145])
  return encodePng(WIDTH, HEIGHT, fb)
}

export function fakeBotScreenStatus(agentId: string, now: number): BotScreenStatus {
  return agentId === 'builder'
    ? { state: 'running', width: WIDTH, height: HEIGHT, frameSeq: Math.floor(now / 1000) }
    : { state: 'off' }
}

export function fakeBotScreenFrame(
  agentId: string,
  now: number,
): { seq: number; png: Buffer } | BotScreenStatus {
  const status = fakeBotScreenStatus(agentId, now)
  if (status.state !== 'running') return status
  const seq = status.frameSeq!
  let png = cache.get(seq % 640)
  if (!png) {
    png = draw(seq)
    if (cache.size > 32) cache.clear()
    cache.set(seq % 640, png)
  }
  return { seq, png }
}
