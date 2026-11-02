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

// 3.17.0: the demo's takeover. Fake mode has no Hermes lease: one session at a time holds builder's screen, others see
// `human`, and input is counted, not drawn. Idle and the hard limit end it as in live mode.
const IDLE_MS = 5 * 60_000
const LIMIT_MS = 30 * 60_000
interface FakeControl {
  takeoverId: string
  owner: string
  since: number
  lastInput: number
  expiresAt: number
}
export class FakeBotTakeovers {
  private readonly controls = new Map<string, FakeControl>()
  /** Input events received per agent (tests read it). */
  readonly inputs = new Map<string, number>()

  status(agentId: string, viewer: string | undefined, now: number): BotScreenStatus {
    const base = fakeBotScreenStatus(agentId, now)
    const control = this.current(agentId, now)
    if (!control) return base
    if (control.owner !== viewer) return { state: 'human' }
    return {
      ...base,
      control: {
        takeoverId: control.takeoverId,
        since: new Date(control.since).toISOString(),
        idleExpiresAt: new Date(control.lastInput + IDLE_MS).toISOString(),
        expiresAt: new Date(control.expiresAt).toISOString(),
      },
    }
  }
  take(agentId: string, owner: string, now: number, id: string) {
    if (fakeBotScreenStatus(agentId, now).state !== 'running')
      return {
        ok: false as const,
        code: 'not_running' as const,
        message: 'The screen isn’t running right now.',
      }
    if (this.current(agentId, now))
      return {
        ok: false as const,
        code: 'busy' as const,
        message: 'Someone already has control of this screen.',
      }
    const control = { takeoverId: id, owner, since: now, lastInput: now, expiresAt: now + LIMIT_MS }
    this.controls.set(agentId, control)
    return {
      ok: true as const,
      takeoverId: id,
      since: now,
      lastInput: now,
      expiresAt: control.expiresAt,
    }
  }
  input(
    agentId: string,
    owner: string,
    takeoverId: string,
    count: number,
    now: number,
  ): 'sent' | 'lost' {
    const control = this.held(agentId, owner, takeoverId, now)
    if (!control) return 'lost'
    control.lastInput = now
    this.inputs.set(agentId, (this.inputs.get(agentId) ?? 0) + count)
    return 'sent'
  }
  heartbeat(agentId: string, owner: string, takeoverId: string, now: number): boolean {
    return this.held(agentId, owner, takeoverId, now) !== undefined
  }
  handBack(agentId: string, owner: string, takeoverId: string, now: number): boolean {
    if (!this.held(agentId, owner, takeoverId, now)) return false
    this.controls.delete(agentId)
    return true
  }
  private held(agentId: string, owner: string, takeoverId: string, now: number) {
    const control = this.current(agentId, now)
    return control && control.owner === owner && control.takeoverId === takeoverId
      ? control
      : undefined
  }
  private current(agentId: string, now: number) {
    const control = this.controls.get(agentId)
    if (control && (now - control.lastInput > IDLE_MS || now >= control.expiresAt)) {
      this.controls.delete(agentId)
      return undefined
    }
    return control
  }
}
