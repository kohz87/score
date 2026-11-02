import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  BotScreens,
  encodePng,
  keyEvent,
  leaseHolder,
  pointerEvent,
} from '../../src/hermes/live/bot-screen.ts'

// A stand-in for Hermes' Xvnc on a real Unix socket: RFB 3.8, security None, Raw rectangles. It records every byte
// Score writes so the test can prove the client only ever sends the three read-only message types.

interface FakeXvnc {
  server: Server
  received: Buffer[]
  clients: Socket[]
  /** What the next update request is answered with. */
  paint: (socket: Socket) => void
}

let dir: string
let home: string
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-bot-screen-'))
  home = join(dir, 'profiles', 'builder')
  mkdirSync(join(home, 'bot-desktop'), { recursive: true })
})
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  rmSync(dir, { recursive: true, force: true })
})

function rect(x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
  const head = Buffer.alloc(12)
  head.writeUInt16BE(x, 0)
  head.writeUInt16BE(y, 2)
  head.writeUInt16BE(w, 4)
  head.writeUInt16BE(h, 6)
  head.writeInt32BE(0, 8)
  const pixels = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) pixels.set([...rgb, 0], i * 4)
  return Buffer.concat([head, pixels])
}
function update(...rects: Buffer[]) {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(rects.length, 2)
  return Buffer.concat([head, ...rects])
}

async function fakeXvnc(
  width = 4,
  height = 2,
  options: { encoding?: number } = {},
): Promise<FakeXvnc> {
  const fake: FakeXvnc = {
    server: createServer(),
    received: [],
    clients: [],
    paint: (socket) => socket.write(update(rect(0, 0, width, height, [10, 20, 30]))),
  }
  fake.server.on('connection', (socket) => {
    fake.clients.push(socket)
    let stage = 0
    let pending = Buffer.alloc(0)
    socket.write('RFB 003.008\n')
    socket.on('data', (chunk: Buffer) => {
      fake.received.push(chunk)
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        if (stage === 0 && pending.length >= 12) {
          pending = pending.subarray(12)
          socket.write(Buffer.from([1, 1]))
          stage = 1
        } else if (stage === 1 && pending.length >= 1) {
          pending = pending.subarray(1)
          socket.write(Buffer.alloc(4))
          stage = 2
        } else if (stage === 2 && pending.length >= 1) {
          pending = pending.subarray(1)
          const init = Buffer.alloc(24 + 4)
          init.writeUInt16BE(width, 0)
          init.writeUInt16BE(height, 2)
          init.writeUInt32BE(4, 20)
          init.write('test', 24)
          socket.write(init)
          stage = 3
        } else if (stage === 3 && pending.length >= 1) {
          const type = pending[0]
          const length =
            type === 0
              ? 20
              : type === 2
                ? 4 + 4 * (pending.readUInt16BE(2) || 0)
                : type === 3
                  ? 10
                  : type === 4
                    ? 8
                    : type === 5
                      ? 6
                      : 1
          if (pending.length < length) break
          pending = pending.subarray(length)
          if (type === 3) {
            if (options.encoding !== undefined) {
              const bad = rect(0, 0, 1, 1, [0, 0, 0])
              bad.writeInt32BE(options.encoding, 8)
              socket.write(update(bad))
            } else fake.paint(socket)
          }
        } else break
      }
    })
    socket.on('error', () => {})
  })
  const path = join(home, 'bot-desktop', 'rfb.sock')
  await new Promise<void>((resolve) => fake.server.listen(path, resolve))
  servers.push(fake.server)
  return fake
}

/** Splits what the client wrote into messages and returns their type bytes (after the 14-byte handshake). */
function clientMessageTypes(received: Buffer[]): number[] {
  let bytes = Buffer.concat(received)
  expect(bytes.subarray(0, 12).toString('latin1')).toBe('RFB 003.008\n')
  expect([...bytes.subarray(12, 14)]).toEqual([1, 1]) // security None, shared
  bytes = bytes.subarray(14)
  const types: number[] = []
  while (bytes.length) {
    const type = bytes[0]!
    const length =
      type === 0
        ? 20
        : type === 2
          ? 4 + 4 * bytes.readUInt16BE(2)
          : type === 3
            ? 10
            : type === 4
              ? 8
              : type === 5
                ? 6
                : -1
    if (length < 0) throw new Error(`client wrote message type ${type}`)
    types.push(type)
    bytes = bytes.subarray(length)
  }
  return types
}

function screens() {
  return new BotScreens({ profileHome: (id) => (id === 'builder' ? home : null) })
}

function pngPixels(png: Buffer) {
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const idatLength = png.readUInt32BE(33)
  const raw = inflateSync(png.subarray(41, 41 + idatLength))
  return { width, height, raw }
}

test('reads the screen and serves it as PNG, writing only read-only RFB messages', async () => {
  const fake = await fakeXvnc()
  const bot = screens()
  try {
    const status = await bot.status('builder')
    expect(status).toMatchObject({ state: 'running', width: 4, height: 2 })
    const frame = await bot.frame('builder')
    expect('png' in frame).toBe(true)
    if (!('png' in frame)) return
    const { width, height, raw } = pngPixels(frame.png)
    expect([width, height]).toEqual([4, 2])
    expect([...raw.subarray(0, 4)]).toEqual([0, 10, 20, 30])
    // A later partial update lands in place.
    fake.paint = (socket) => socket.write(update(rect(1, 1, 1, 1, [200, 100, 50])))
    await bot.status('builder')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = await bot.frame('builder')
    if (!('png' in next)) throw new Error('no frame')
    expect(next.seq).toBeGreaterThan(frame.seq)
    const pixels = pngPixels(next.png).raw
    const row1 = 1 + 4 * 3 // second row starts after its filter byte
    expect([...pixels.subarray(row1 + 1 + 3, row1 + 1 + 6)]).toEqual([200, 100, 50])
    const types = clientMessageTypes(fake.received)
    expect(new Set(types)).toEqual(new Set([0, 2, 3]))
  } finally {
    bot.close()
  }
})

test('advertises only Raw and DesktopSize', async () => {
  const fake = await fakeXvnc()
  const bot = screens()
  try {
    await bot.status('builder')
    const bytes = Buffer.concat(fake.received).subarray(14 + 20)
    expect(bytes[0]).toBe(2)
    expect(bytes.readUInt16BE(2)).toBe(2)
    expect([bytes.readInt32BE(4), bytes.readInt32BE(8)]).toEqual([0, -223])
  } finally {
    bot.close()
  }
})

test('while a human holds the screen nothing is served and the connection is dropped', async () => {
  const fake = await fakeXvnc()
  const bot = screens()
  try {
    expect((await bot.status('builder')).state).toBe('running')
    writeFileSync(join(home, 'bot-desktop', 'lease.json'), JSON.stringify({ holder: 'human' }))
    expect(await bot.frame('builder')).toEqual({ state: 'human' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.clients.every((client) => client.destroyed || client.readableEnded)).toBe(true)
  } finally {
    bot.close()
  }
})

test('the lease follows Hermes: missing = agent, corrupt or unreadable = human', async () => {
  const botDir = join(home, 'bot-desktop')
  expect(await leaseHolder(botDir)).toBe('agent')
  writeFileSync(join(botDir, 'lease.json'), '{not json')
  expect(await leaseHolder(botDir)).toBe('human')
  writeFileSync(join(botDir, 'lease.json'), JSON.stringify({ holder: 'nobody' }))
  expect(await leaseHolder(botDir)).toBe('human')
  writeFileSync(join(botDir, 'lease.json'), '﻿' + JSON.stringify({ holder: 'agent', since: 1 }))
  expect(await leaseHolder(botDir)).toBe('agent')
})

test('off, sandboxed, unknown profile and an untrusted socket', async () => {
  const bot = screens()
  try {
    expect((await bot.status('builder')).state).toBe('off')
    expect((await bot.status('stranger')).state).toBe('unavailable')
    writeFileSync(join(home, 'bot-desktop', 'sandbox.json'), JSON.stringify({ backend: 'Docker' }))
    expect((await bot.status('builder')).state).toBe('sandboxed')
    rmSync(join(home, 'bot-desktop', 'sandbox.json'))
    // A symlink to some other socket is refused, never followed.
    const elsewhere = join(dir, 'other.sock')
    const other = createServer()
    servers.push(other)
    await new Promise<void>((resolve) => other.listen(elsewhere, resolve))
    symlinkSync(elsewhere, join(home, 'bot-desktop', 'rfb.sock'))
    expect((await bot.status('builder')).state).toBe('unavailable')
    rmSync(join(home, 'bot-desktop', 'rfb.sock'))
    // A plain file is not a socket.
    writeFileSync(join(home, 'bot-desktop', 'rfb.sock'), '')
    expect((await bot.status('builder')).state).toBe('unavailable')
  } finally {
    bot.close()
  }
})

test('a screen that claims a huge size or an unrequested encoding is closed, not read', async () => {
  await fakeXvnc(5000, 10)
  const bot = screens()
  try {
    expect((await bot.status('builder')).state).toBe('off')
  } finally {
    bot.close()
  }
  rmSync(join(home, 'bot-desktop', 'rfb.sock'))
  await fakeXvnc(4, 2, { encoding: 7 })
  const again = screens()
  try {
    expect((await again.status('builder')).state).toBe('off')
  } finally {
    again.close()
  }
})

test('PNG encoding keeps pixel order and size', () => {
  const rgbx = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0])
  const { width, height, raw } = pngPixels(encodePng(2, 1, rgbx))
  expect([width, height]).toEqual([2, 1])
  expect([...raw]).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('polls that arrive while the first connection is still opening wait for its first frame', async () => {
  await fakeXvnc()
  const bot = screens()
  try {
    const [a, b, frame] = await Promise.all([
      bot.status('builder'),
      bot.status('builder'),
      bot.frame('builder'),
    ])
    expect(a).toMatchObject({ state: 'running', width: 4, height: 2 })
    expect(b).toMatchObject({ state: 'running', width: 4, height: 2 })
    expect('png' in frame && frame.png.readUInt32BE(16)).toBe(4)
  } finally {
    bot.close()
  }
})

test('a symlinked bot-desktop folder is refused, never followed', async () => {
  const real = join(dir, 'elsewhere')
  mkdirSync(real)
  rmSync(join(home, 'bot-desktop'), { recursive: true })
  symlinkSync(real, join(home, 'bot-desktop'))
  const other = createServer()
  servers.push(other)
  await new Promise<void>((resolve) => other.listen(join(real, 'rfb.sock'), resolve))
  const bot = screens()
  try {
    expect((await bot.status('builder')).state).toBe('unavailable')
  } finally {
    bot.close()
  }
})

// ---- 3.17.0: taking over (docs/briefs/3.17.0-take-over.md) ----
const lease = (value: object) =>
  writeFileSync(join(home, 'bot-desktop', 'lease.json'), JSON.stringify(value))
const VIEWER = 'score:abcdefghijklmnop'
const control = (over: object = {}) => ({
  takeoverId: 't1',
  viewerId: VIEWER,
  epoch: 3,
  owner: 'me',
  since: Date.now(),
  lastInput: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...over,
})
const inputTypes = (fake: FakeXvnc) => clientMessageTypes(fake.received).filter((t) => t >= 4)

test('input goes out only while Hermes’ lease names the takeover, and only its owner sees the screen', async () => {
  const fake = await fakeXvnc(100, 50)
  const lost: string[] = []
  const bot = new BotScreens({
    profileHome: (id) => (id === 'builder' ? home : null),
    onLost: (_agent, held) => lost.push(held.takeoverId),
  })
  try {
    expect((await bot.status('builder', 'me')).state).toBe('running')
    const key = [{ k: 'key', keysym: 0x61, down: true } as const]
    // No takeover: nothing is sent.
    expect(await bot.input('builder', 'me', 't1', key)).toBe('lost')
    lease({ holder: 'human', viewer_id: VIEWER, epoch: 3 })
    bot.setControl('builder', control())
    expect(await bot.status('builder', 'someone-else')).toEqual({ state: 'human' })
    expect(await bot.status('builder', 'me')).toMatchObject({
      state: 'running',
      control: { takeoverId: 't1' },
    })
    expect(await bot.input('builder', 'someone-else', 't1', key)).toBe('lost')
    expect(
      await bot.input('builder', 'me', 't1', [
        ...key,
        { k: 'key', keysym: 0x61, down: false },
        { k: 'pointer', x: 500, y: 20, buttons: 1 },
      ]),
    ).toBe('sent')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(inputTypes(fake)).toEqual([4, 4, 5])
    const bytes = Buffer.concat(fake.received)
    const pointer = bytes.subarray(bytes.length - 6)
    // Clamped into the screen (x 500 → 99).
    expect([...pointer]).toEqual([5, 1, 0, 99, 0, 20])
    // The Hermes app takes over: the takeover is lost, nothing more is sent, nothing is served.
    lease({ holder: 'human', viewer_id: 'hermes-app', epoch: 4 })
    expect(await bot.frame('builder', 'me')).toEqual({ state: 'human' })
    expect(lost).toEqual(['t1'])
    expect(bot.control('builder')).toBeUndefined()
    expect(await bot.input('builder', 'me', 't1', key)).toBe('lost')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(inputTypes(fake)).toEqual([4, 4, 5])
  } finally {
    bot.close()
  }
})

test('an unreadable lease is never Score’s: the takeover ends', async () => {
  await fakeXvnc()
  const bot = screens()
  try {
    lease({ holder: 'human', viewer_id: VIEWER, epoch: 3 })
    bot.setControl('builder', control())
    expect((await bot.status('builder', 'me')).state).toBe('running')
    writeFileSync(join(home, 'bot-desktop', 'lease.json'), '{torn')
    expect(await bot.status('builder', 'me')).toEqual({ state: 'human' })
    expect(bot.control('builder')).toBeUndefined()
  } finally {
    bot.close()
  }
})

test('the encoders write exactly RFB KeyEvent and PointerEvent', () => {
  expect([...keyEvent(true, 0xff0d)]).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0x0d])
  expect([...pointerEvent(4, 258, 3)]).toEqual([5, 4, 1, 2, 0, 3])
})

test('input past the idle window or the hard limit is refused, even before the sweep ends the takeover', async () => {
  const fake = await fakeXvnc()
  const bot = screens()
  try {
    lease({ holder: 'human', viewer_id: VIEWER, epoch: 3 })
    const key = [{ k: 'key', keysym: 0x61, down: true } as const]
    bot.setControl('builder', control({ lastInput: Date.now() - 6 * 60_000 }))
    expect(await bot.input('builder', 'me', 't1', key)).toBe('lost')
    bot.setControl('builder', control({ expiresAt: Date.now() - 1 }))
    expect(await bot.input('builder', 'me', 't1', key)).toBe('lost')
    // Refused before the screen is even opened: not a byte was written.
    expect(Buffer.concat(fake.received).length).toBe(0)
  } finally {
    bot.close()
  }
})

test('ending a takeover on Score’s side lets go of held keys and buttons; a lost one sends nothing', async () => {
  const fake = await fakeXvnc(100, 50)
  const bot = screens()
  try {
    lease({ holder: 'human', viewer_id: VIEWER, epoch: 3 })
    bot.setControl('builder', control())
    await bot.input('builder', 'me', 't1', [
      { k: 'key', keysym: 0xffe1, down: true },
      { k: 'key', keysym: 0x61, down: true },
      { k: 'key', keysym: 0x61, down: false },
      { k: 'pointer', x: 5, y: 6, buttons: 1 },
    ])
    bot.clearControl('builder')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const bytes = Buffer.concat(fake.received)
    // Shift released and the button let go, after the person's own events.
    expect(inputTypes(fake)).toEqual([4, 4, 4, 5, 4, 5])
    expect([...bytes.subarray(bytes.length - 14, bytes.length - 6)]).toEqual([
      4, 0, 0, 0, 0, 0, 0xff, 0xe1,
    ])
    expect([...bytes.subarray(bytes.length - 6)]).toEqual([5, 0, 0, 5, 0, 6])
  } finally {
    bot.close()
  }
})
