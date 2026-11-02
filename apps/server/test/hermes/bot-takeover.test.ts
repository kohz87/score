import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import type { CommandRequest, RewindOutcome } from '../../src/hermes/bridge/rewind-broker.ts'
import { type BotControl, BotScreens } from '../../src/hermes/live/bot-screen.ts'
import { BotTakeovers } from '../../src/hermes/live/bot-takeover.ts'

// 3.17.0: the takeover service against a stand-in for Score's plugin that keeps Hermes' lease file the way Hermes'
// own lease functions would (docs/briefs/3.17.0-take-over.md). The screen itself is stubbed: these tests are about
// who holds control and which hand-backs are owed.

let dir: string
let home: string
let db: ScoreDb
let now: number
let gateway: 'up' | 'down' | 'silent'
let asked: CommandRequest[]
let hermesLease: { holder: 'agent' | 'human'; viewer_id: string | null; epoch: number }
let controls: Map<string, BotControl>
let screens: BotScreens

const writeLease = () =>
  writeFileSync(join(home, 'bot-desktop', 'lease.json'), JSON.stringify(hermesLease))

async function ask(_profile: string, req: CommandRequest): Promise<RewindOutcome> {
  asked.push(req)
  if (gateway === 'down') return { status: 'unavailable' }
  if (req.kind === 'desktop_take') {
    hermesLease = { holder: 'human', viewer_id: req.viewerId, epoch: hermesLease.epoch + 1 }
    writeLease()
    if (gateway === 'silent') return { status: 'no_answer' }
  } else if (req.kind === 'desktop_hand_back') {
    if (hermesLease.viewer_id === req.viewerId && hermesLease.epoch === req.epoch)
      hermesLease = { holder: 'agent', viewer_id: null, epoch: hermesLease.epoch + 1 }
    writeLease()
  }
  const lease = {
    holder: hermesLease.holder,
    viewerId: hermesLease.viewer_id,
    epoch: hermesLease.epoch,
  }
  return {
    status: 'done',
    turnsUndone: 0,
    rewoundCount: 0,
    lease,
  }
}

function service() {
  return new BotTakeovers({
    screens,
    ask,
    db,
    profileHome: () => home,
    clock: () => now,
  })
}
const rows = () =>
  db.sqlite
    .prepare('SELECT state, end_reason, epoch FROM bot_takeovers ORDER BY started_at')
    .all() as { state: string; end_reason: string | null; epoch: number | null }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-bot-takeover-'))
  home = join(dir, 'builder')
  mkdirSync(join(home, 'bot-desktop'), { recursive: true })
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  now = Date.parse('2026-11-02T12:00:00Z')
  gateway = 'up'
  asked = []
  hermesLease = { holder: 'agent', viewer_id: null, epoch: 0 }
  controls = new Map()
  // The screen is running and settles control the way BotScreens does; only control bookkeeping is real here.
  screens = Object.assign(Object.create(BotScreens.prototype) as BotScreens, {
    status: async () => ({ state: 'running' as const, width: 10, height: 10, frameSeq: 1 }),
    control: (id: string) => controls.get(id),
    setControl: (id: string, control: BotControl) => void controls.set(id, control),
    clearControl: (id: string) => void controls.delete(id),
  })
})
afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

test('take asks Hermes through the plugin and records the generation; hand back releases exactly it', async () => {
  const takeovers = service()
  const result = await takeovers.take('builder', 'me')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(asked[0]).toMatchObject({ kind: 'desktop_take' })
  expect(rows()).toEqual([{ state: 'active', end_reason: null, epoch: 1 }])
  expect(await takeovers.take('builder', 'someone-else')).toMatchObject({ ok: false, code: 'busy' })
  expect(await takeovers.handBack('builder', 'someone-else', result.control.takeoverId)).toBe(false)
  expect(await takeovers.handBack('builder', 'me', result.control.takeoverId)).toBe(true)
  expect(asked.at(-1)).toEqual({
    kind: 'desktop_hand_back',
    viewerId: result.control.viewerId,
    epoch: 1,
  })
  expect(hermesLease.holder).toBe('agent')
  expect(rows()).toEqual([{ state: 'ended', end_reason: 'handed_back', epoch: 1 }])
  expect(controls.size).toBe(0)
  await takeovers.close()
})

test('a hand-back the gateway can’t take now stays owed and is retried until it lands', async () => {
  const takeovers = service()
  const result = await takeovers.take('builder', 'me')
  if (!result.ok) throw new Error('not taken')
  gateway = 'down'
  await takeovers.handBack('builder', 'me', result.control.takeoverId)
  expect(rows()[0]).toMatchObject({ state: 'releasing', end_reason: 'handed_back' })
  expect(hermesLease.holder).toBe('human')
  gateway = 'up'
  await takeovers.tick()
  expect(rows()[0]).toMatchObject({ state: 'ended' })
  expect(hermesLease.holder).toBe('agent')
  await takeovers.close()
})

test('after a restart, a takeover Score held is handed back', async () => {
  const first = service()
  const result = await first.take('builder', 'me')
  if (!result.ok) throw new Error('not taken')
  // Stopping hands back at once when the gateway answers; here it is down, so the next start does it.
  gateway = 'down'
  await first.close()
  expect(controls.size).toBe(0)
  gateway = 'up'
  const second = service()
  expect(rows()[0]).toMatchObject({ state: 'releasing', end_reason: 'restart' })
  await second.tick()
  expect(rows()[0]).toMatchObject({ state: 'ended' })
  expect(hermesLease.holder).toBe('agent')
  await second.close()
})

test('five minutes without input, the hard limit, or a page that stopped beating hands back', async () => {
  const takeovers = service()
  for (const [advance, reason, beat] of [
    [5 * 60_000 + 1, 'idle', true],
    [31 * 60_000, 'limit', true],
    [31_000, 'left', false],
  ] as const) {
    const result = await takeovers.take('builder', 'me')
    if (!result.ok) throw new Error('not taken')
    const control = controls.get('builder')!
    const start = now
    // Input keeps arriving except for the idle case, so only the reason under test applies.
    const step = reason === 'idle' ? advance : Math.min(advance, 20_000)
    while (now - start < advance) {
      now += step
      if (reason !== 'idle') control.lastInput = now
      if (beat) takeovers.heartbeat('builder', 'me', result.control.takeoverId)
      await takeovers.tick()
    }
    expect(controls.size).toBe(0)
    expect(rows().at(-1)).toMatchObject({ state: 'ended', end_reason: reason })
    expect(hermesLease.holder).toBe('agent')
  }
  await takeovers.close()
})

test('a take whose answer never came is handed back if Hermes granted it, and only then', async () => {
  const takeovers = service()
  gateway = 'silent'
  expect(await takeovers.take('builder', 'me')).toMatchObject({ ok: false, code: 'failed' })
  // Hermes granted it: the release read the lease, found Score's viewer and handed back that generation.
  expect(hermesLease.holder).toBe('agent')
  expect(rows()[0]).toMatchObject({ state: 'ended' })
  // Granted to someone else meanwhile: nothing is released.
  gateway = 'silent'
  await takeovers.take('builder', 'me')
  hermesLease = { holder: 'human', viewer_id: 'hermes-app', epoch: 9 }
  writeLease()
  gateway = 'up'
  await takeovers.tick()
  expect(hermesLease).toEqual({ holder: 'human', viewer_id: 'hermes-app', epoch: 9 })
  expect(rows()[1]).toMatchObject({ state: 'ended' })
  await takeovers.close()
})

test('the desktop is marked in use once a minute while Score holds it', async () => {
  const takeovers = service()
  const result = await takeovers.take('builder', 'me')
  if (!result.ok) throw new Error('not taken')
  const touches = () => asked.filter((req) => req.kind === 'desktop_touch').length
  now += 30_000
  takeovers.heartbeat('builder', 'me', result.control.takeoverId)
  controls.get('builder')!.lastInput = now
  await takeovers.tick()
  expect(touches()).toBe(0)
  now += 30_000
  takeovers.heartbeat('builder', 'me', result.control.takeoverId)
  await takeovers.tick()
  expect(touches()).toBe(1)
  await takeovers.close()
})

// Security review (3.17.0): races and loose ends.
test('two sessions taking at once: one gets the screen, the other is told it’s busy', async () => {
  const takeovers = service()
  const [a, b] = await Promise.all([
    takeovers.take('builder', 'me'),
    takeovers.take('builder', 'you'),
  ])
  const granted = [a, b].filter((result) => result.ok)
  expect(granted).toHaveLength(1)
  expect([a, b].find((result) => !result.ok)).toMatchObject({ code: 'busy' })
  expect(asked.filter((req) => req.kind === 'desktop_take')).toHaveLength(1)
  await takeovers.close()
})

test('stopping Score hands back what it holds', async () => {
  const takeovers = service()
  await takeovers.take('builder', 'me')
  await takeovers.close()
  expect(hermesLease.holder).toBe('agent')
  expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'restart' })
})

test('a take refused because a person holds the screen is busy, and nothing is released', async () => {
  const takeovers = service()
  hermesLease = { holder: 'human', viewer_id: 'hermes-app', epoch: 4 }
  writeLease()
  const realAsk = ask
  const refusing = new BotTakeovers({
    screens,
    ask: async (profile, req) =>
      req.kind === 'desktop_take'
        ? {
            status: 'done',
            turnsUndone: 0,
            rewoundCount: 0,
            lease: { holder: 'human', viewerId: 'hermes-app', epoch: 4 },
          }
        : realAsk(profile, req),
    db,
    profileHome: () => home,
    clock: () => now,
  })
  expect(await refusing.take('builder', 'me')).toMatchObject({ ok: false, code: 'busy' })
  expect(hermesLease).toEqual({ holder: 'human', viewer_id: 'hermes-app', epoch: 4 })
  expect(rows()[0]).toMatchObject({ state: 'ended' })
  await refusing.close()
  await takeovers.close()
})

test('an active record the screen doesn’t hold is handed back by the sweep', async () => {
  const takeovers = service()
  const result = await takeovers.take('builder', 'me')
  if (!result.ok) throw new Error('not taken')
  controls.clear() // as if a raced take had replaced it on the screen
  await takeovers.tick()
  expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'lost' })
  expect(hermesLease.holder).toBe('agent')
  await takeovers.close()
})
