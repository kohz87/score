import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { BotScreens, encodePng, leaseHolder } from '../../src/hermes/live/bot-screen.ts'

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
      type === 0 ? 20 : type === 2 ? 4 + 4 * bytes.readUInt16BE(2) : type === 3 ? 10 : -1
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
