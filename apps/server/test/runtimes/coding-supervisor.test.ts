import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type net from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import {
  alive,
  receipts,
  startHarness,
  SUPERVISOR,
  type Harness,
  type HarnessOptions,
} from '../helpers/coding-harness.ts'

// 7.7a part 2: the supervisor with harmless `node -e` CLIs and an injected cgroup (no systemd). Fake-boundary tests.

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.server.shutdown()
    await Promise.race([h.done, new Promise((r) => setTimeout(r, 5000))])
    // Survivors this test's CLIs recorded: its own processes, never anything else.
    if (existsSync(h.cgroup.survivorsFile)) h.cgroup.killPayload()
  }
})

async function run(options: HarnessOptions, drive?: (h: Harness) => Promise<void>) {
  const h = await startHarness(options)
  harnesses.push(h)
  await h.session.ready
  await drive?.(h)
  if (!drive) h.session.go()
  const outcome = await h.outcome
  const code = await h.done
  return { h, outcome, code }
}

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>

test('a normal run: output, exit, payload empty, receipts, end/ack-end, exit 0 (design 4)', async () => {
  const { h, outcome, code } = await run({
    script: `
      console.log(JSON.stringify({ a: 1 })); console.log(JSON.stringify({ pid: process.pid }));
      console.error('diagnostic')`,
  })
  expect(code).toBe(0)
  expect(outcome).toMatchObject({ kind: 'ended', eligible: true, exit: { code: 0, signal: null } })
  expect(h.stdout.map((l) => JSON.parse(l))).toHaveLength(2)
  expect(h.stderr.join('')).toBe('diagnostic\n')
  expect(receipts(h)).toEqual(['ended.json', 'released.json'])
  expect(json(join(h.receiptDir, 'ended.json'))).toMatchObject({
    launch: 'launch1',
    code: 0,
    stopCause: null,
  })
  // The wrapper wrote the CLI's own pid into the payload cgroup before exec (the CLI is born inside it).
  const cliPid = JSON.parse(h.stdout[1]!).pid as number
  expect(readFileSync(join(h.dir, 'cg', 'payload', 'cgroup.procs'), 'utf8')).toBe(String(cliPid))
})

test('the prompt reaches the CLI on stdin', async () => {
  const { h, outcome } = await run({
    stdin: 'hello prompt',
    script: `let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({s})))`,
  })
  expect(outcome.eligible).toBe(true)
  expect(JSON.parse(h.stdout[0]!)).toEqual({ s: 'hello prompt' })
})

test('large lines are chunked with sequence numbers and reassembled intact, multibyte characters included', async () => {
  const { h, outcome } = await run({
    script: `console.log('€'.repeat(150000)); console.log('😀'.repeat(40000)); console.log('x')`,
  })
  expect(outcome.eligible).toBe(true)
  expect(h.stdout).toEqual(['€'.repeat(150000), '😀'.repeat(40000), 'x'])
})

test('a partial last stdout line at eof is a dropped record (lossy); a partial stderr line is just text', async () => {
  const { h, outcome } = await run({
    script: `process.stdout.write('{"ok":1}\\n{"cut'); process.stderr.write('partial err')`,
  })
  expect(h.stdout).toEqual(['{"ok":1}'])
  expect(h.stderr.join('')).toBe('partial err')
  expect(outcome).toMatchObject({ kind: 'ended', eligible: false, droppedRecords: 1 })
  expect(outcome.reasons).toContain('dropped-record')
})

test('escalation is INT then TERM then KILL, one grace each, no signal twice (design 1)', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'score-sig-')), 'sig.log')
  const { outcome, code, h } = await run(
    {
      graceMs: 400,
      script: `
        const fs=require('fs'); const log=process.env.SIGLOG;
        for (const s of ['SIGINT','SIGTERM']) process.on(s,()=>fs.appendFileSync(log, s+'\\n'));
        console.log('up'); setInterval(()=>{}, 1000)`,
    },
    async (h) => {
      h.spec.command.env.SIGLOG = log
      h.session.go()
      await vi.waitFor(() => expect(h.stdout).toContain('up'))
      h.session.stop('user')
    },
  )
  void h
  expect(code).toBe(0)
  expect(readFileSync(log, 'utf8')).toBe('SIGINT\nSIGTERM\n')
  expect(outcome.exit).toEqual({ code: null, signal: 'SIGKILL' })
  expect(outcome.stopCause).toBe('user')
  expect(outcome.eligible).toBe(false)
})

test('cancel before go: no CLI, no released receipt (nothing ran)', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'score-cancel-')), 'ran')
  const { h, outcome, code } = await run(
    { script: `require('fs').writeFileSync(process.env.MARK,'x')` },
    async (h) => {
      h.spec.command.env.MARK = marker
      h.session.cancel()
    },
  )
  expect(code).toBe(0)
  expect(outcome.kind).toBe('lost')
  expect(existsSync(marker)).toBe(false)
  expect(receipts(h)).toEqual([])
})

test('a receipt that cannot be written fails closed: the CLI is not started (design 3)', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'score-failclosed-')), 'ran')
  const { outcome, code } = await run(
    { preReceipt: 'released.json', script: `require('fs').writeFileSync(process.env.MARK,'x')` },
    async (h) => {
      h.spec.command.env.MARK = marker
      h.session.go()
    },
  )
  expect(code).toBe(1)
  expect(existsSync(marker)).toBe(false)
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('supervisor-error:receipt')
})

test('socket loss stops the CLI tree, waits for the payload to empty, writes ended, exits 2', async () => {
  const { h, code } = await run(
    { graceMs: 300, script: `console.log(process.pid); setInterval(()=>{}, 1000)` },
    async (h) => {
      h.session.go()
      await vi.waitFor(() => expect(h.stdout.length).toBe(1))
      ;(h.session as unknown as { socket: net.Socket }).socket.destroy()
    },
  )
  expect(code).toBe(2)
  expect(alive(Number(h.stdout[0]))).toBe(false)
  expect(json(join(h.receiptDir, 'ended.json'))).toMatchObject({ stopCause: 'socket-loss' })
})

test('the wall-clock deadline stops the run with cause "deadline"', async () => {
  const { outcome } = await run(
    { deadline: Date.now() + 500, graceMs: 300, script: `setInterval(()=>{}, 1000)` },
    async (h) => h.session.go(),
  )
  expect(outcome.stopCause).toBe('deadline')
  expect(outcome.eligible).toBe(false)
  expect(outcome.exit?.signal).toBe('SIGINT')
})

test('a survivor that outlives the CLI is killed through the cgroup after one grace; `end` waits for emptiness', async () => {
  const { h, outcome, code } = await run({
    graceMs: 300,
    script: `
      const { spawn } = require('child_process');
      const c = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); c.unref();
      require('fs').appendFileSync(process.env.SURVIVORS, c.pid + '\\n'); console.log(c.pid)`,
  })
  expect(code).toBe(0)
  expect(outcome).toMatchObject({ kind: 'ended', survivorsKilled: true })
  expect(alive(Number(h.stdout[0]))).toBe(false)
  expect(json(join(h.receiptDir, 'ended.json'))).toMatchObject({ survivorsKilled: true })
})

test('backpressure: a slow consumer pauses the socket and the CLI blocks; memory stays bounded; nothing is lost', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let count = 0
  const marker = join(mkdtempSync(join(tmpdir(), 'score-bp-')), 'written')
  const { h, outcome } = await run(
    {
      limits: { pauseBytes: 100 * 1024 },
      handlers: {
        onStdoutRecord: async () => {
          if (count === 0) await gate
          count += 1
        },
      },
      script: `
        const line = 'y'.repeat(1023) + '\\n'; let n = 0;
        (function w(){ while (n < 40000) { n++; if (!process.stdout.write(line)) return process.stdout.once('drain', w) }
          require('fs').writeFileSync(process.env.MARK, 'x') })()`,
    },
    async (h) => {
      h.spec.command.env.MARK = marker
      h.session.go()
      // 40 MB cannot sit in pipes and socket buffers: the CLI must be blocked, and Score's buffer bounded.
      await new Promise((r) => setTimeout(r, 1500))
      expect(existsSync(marker)).toBe(false)
      expect(h.server.bufferedBytes).toBeLessThan(2 * 1024 * 1024)
      expect((h.session as unknown as { socket: net.Socket }).socket.isPaused()).toBe(true)
      release()
    },
  )
  void h
  expect(outcome.eligible).toBe(true)
  expect(count).toBe(40000)
})

test('per-stream byte cap: the supervisor reports it, stops the CLI, and the result is ineligible', async () => {
  const { outcome } = await run({
    specLimits: { maxStreamBytes: 100 * 1024 },
    graceMs: 300,
    script: `const b='z'.repeat(1023)+'\\n'; setInterval(()=>{for(let i=0;i<50;i++)process.stdout.write(b)},10)`,
  })
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('supervisor-error:output-cap')
})

test('an ingest failure makes the result ineligible and stops the run (the swallowed-error path is gone)', async () => {
  const { outcome } = await run({
    graceMs: 300,
    handlers: {
      onStdoutRecord: (line) => {
        if (line === 'boom') throw new Error('cannot translate')
      },
    },
    script: `console.log('ok'); console.log('boom'); setInterval(()=>console.log('more'), 20)`,
  })
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('ingest-failure')
})

test('watchdog pings come from the control loop at the configured interval', async () => {
  let pings = 0
  await run({
    watchdog: () => void (pings += 1),
    watchdogMs: 100,
    script: `setTimeout(()=>{}, 800)`,
  })
  expect(pings).toBeGreaterThanOrEqual(4)
})

test('a rejected hello (wrong token) ends the supervisor with code 3 and starts nothing', async () => {
  const h = await startHarness({
    script: `require('fs').writeFileSync(process.env.MARK,'x')`,
    token: 'forged',
  })
  harnesses.push(h)
  expect(await h.done).toBe(3)
  expect(receipts(h)).toEqual([])
})

test('a bad spec file ends a real supervisor process with exit 4', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'score-badspec-')), 'spec.json')
  writeFileSync(file, '{"launch":"x"}')
  let status = 0
  try {
    execFileSync(process.execPath, ['--no-warnings', SUPERVISOR, file], {
      stdio: 'ignore',
      timeout: 10_000,
    })
  } catch (error) {
    status = (error as { status: number }).status
  }
  expect(status).toBe(4)
})
