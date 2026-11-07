import {
  chmodSync,
  writeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { receipts } from '../helpers/coding-harness.ts'
import { parseReceipt, syncReceipt, writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'
import { json, run, setupSupervisorTestLifecycle } from './coding-supervisor-helpers.ts'

setupSupervisorTestLifecycle()

test('a receipt that fails mid-write leaves no file under the final name (review #8, test fixed in FY1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-receipt-'))
  // A real short write, then an I/O error: the temp file holds a partial body when the write throws.
  let calls = 0
  const io = {
    writeSync: (fd: number, data: Buffer, off: number, len: number) => {
      calls += 1
      if (calls > 1) throw new Error('EIO')
      return writeSync(fd, data, off, Math.min(5, len))
    },
  }
  expect(() => writeReceipt(dir, 'released.json', { launch: 'L', generation: 1 }, io)).toThrow(
    'EIO',
  )
  expect(calls).toBe(2)
  expect(readdirSync(dir)).toEqual([])
  // A failing publish (link) after a complete temp file also leaves nothing under the final name.
  expect(() =>
    writeReceipt(
      dir,
      'ended.json',
      { launch: 'L' },
      {
        linkSync: () => {
          throw new Error('EXDEV')
        },
      },
    ),
  ).toThrow('EXDEV')
  expect(readdirSync(dir)).toEqual([])
})

test('a receipt appears whole, exactly once, with no temp leftovers (review #8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-receipt-'))
  writeReceipt(dir, 'ended.json', {
    launch: 'L',
    generation: 1,
    at: 5,
    code: 0,
    signal: null,
    survivorsKilled: false,
  })
  expect(readdirSync(dir)).toEqual(['ended.json'])
  expect(JSON.parse(readFileSync(join(dir, 'ended.json'), 'utf8'))).toMatchObject({ launch: 'L' })
  expect(() => writeReceipt(dir, 'ended.json', { other: true })).toThrow()
  expect(JSON.parse(readFileSync(join(dir, 'ended.json'), 'utf8'))).toMatchObject({ launch: 'L' })
  expect(readdirSync(dir)).toEqual(['ended.json'])
  chmodSync(dir, 0o700)
})

test('readers reject empty, partial, malformed and foreign receipts (review #8)', () => {
  const ended = { launch: 'L', generation: 2, at: 5, code: 0, signal: null, survivorsKilled: false }
  const ok = JSON.stringify(ended) + '\n'
  expect(parseReceipt(ok, 'ended', { launch: 'L', generation: 2 }).state).toBe('present')
  for (const bad of [
    '',
    '{}',
    '{"launch":"L"',
    'null',
    '[]',
    JSON.stringify({ ...ended, launch: 'X' }),
  ])
    expect(parseReceipt(bad, 'ended', { launch: 'L', generation: 2 }).state).toBe('invalid')
  expect(parseReceipt(ok, 'ended', { launch: 'L', generation: 3 }).state).toBe('invalid')
  expect(parseReceipt(ok, 'released', { launch: 'L' }).state).toBe('invalid')
})

test('FV #2: a final receipt whose directory sync fails is removed again and the supervisor exits non-zero', async () => {
  const { h, code } = await run({
    script: 'console.log(JSON.stringify({ a: 1 }))',
    receiptIo: {
      fsyncSync: (fd: number) => {
        if (fstatSync(fd).isDirectory())
          throw Object.assign(new Error('input/output error'), { code: 'EIO' })
        fsyncSync(fd)
      },
    },
  })
  expect(code).not.toBe(0)
  expect(receipts(h)).toEqual(['ended.json', 'released.json'])
})

test('FV #2: an existing receipt is made durable again before it is trusted (syncReceipt), and a missing one is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-sync-'))
  try {
    writeReceipt(dir, 'x.json', { launch: 'l', generation: 0, at: 1 })
    const synced: boolean[] = []
    syncReceipt(dir, 'x.json', {
      fsyncSync: (fd: number) => {
        synced.push(fstatSync(fd).isDirectory())
        fsyncSync(fd)
      },
    })
    expect(synced).toEqual([false, true])
    expect(() => syncReceipt(dir, 'missing.json')).toThrow()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("7.7b-2 0b: a `go` that arrives after the absolute expiry doesn't spawn; the supervisor reports `expired` with a receipt", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'score-expired-')), 'ran')
  const { h, outcome, code } = await run(
    // The control loop ticks once a minute, so only the `go` handler can notice the expiry in time.
    {
      deadline: Date.now() + 300,
      tickMs: 60_000,
      script: `require('fs').writeFileSync(process.env.MARK,'x')`,
    },
    async (h) => {
      h.spec.command.env.MARK = marker
      await new Promise((resolve) => setTimeout(resolve, 600))
      h.session.go()
    },
  )
  expect(code).not.toBeUndefined()
  expect(existsSync(marker)).toBe(false)
  expect(outcome.kind).toBe('lost')
  expect(outcome.reasons).toContain('supervisor-error:expired')
  // `released.json` is the receipt of a spawn: it must not exist. `expired.json` says why.
  expect(receipts(h)).toEqual(['expired.json'])
  expect(json(join(h.receiptDir, 'expired.json'))).toMatchObject({ launch: 'launch1' })
})

test('7.7b-F1 #3: a `go` accepted just before the expiry does not spawn when the receipt’s fsyncs carry the clock past it', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'score-expired-')), 'ran')
  const deadline = Date.now() + 60_000
  const holder: { dir?: string } = {}
  const { h, outcome } = await run(
    {
      deadline,
      script: `require('fs').writeFileSync(process.env.MARK,'x')`,
      // Time passes while released.json is being made durable: once the file is there, the clock is past the deadline.
      now: () =>
        holder.dir && existsSync(join(holder.dir, 'released.json')) ? deadline + 1 : Date.now(),
    },
    async (h) => {
      holder.dir = h.receiptDir
      h.spec.command.env.MARK = marker
      h.session.go()
    },
  )
  expect(existsSync(marker)).toBe(false)
  expect(outcome.kind).toBe('lost')
  expect(outcome.reasons).toContain('supervisor-error:expired')
  // `released.json` stays: Score must keep treating the launch as possibly executed.
  expect(receipts(h)).toEqual(['expired.json', 'released.json'])
})
