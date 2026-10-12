import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  writeSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { afterEach, expect, test, vi } from 'vitest'
import {
  alive,
  receipts,
  startHarness,
  SUPERVISOR,
  type Harness,
  type HarnessOptions,
} from '../helpers/coding-harness.ts'
import { parseReceipt, writeReceipt } from '../../src/runtimes/coding/supervisor.mjs'

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

test('a survivor that keeps the CLI pipes open is killed after one grace, and the run still ends (review #1)', async () => {
  const { h, outcome, code } = await run({
    graceMs: 300,
    script: `
      const { spawn } = require('child_process');
      const c = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); c.unref();
      require('fs').appendFileSync(process.env.SURVIVORS, c.pid + '\\n'); console.log(c.pid)`,
  })
  expect(code).toBe(0)
  expect(outcome).toMatchObject({ kind: 'ended', survivorsKilled: true })
  expect(alive(Number(h.stdout[0]))).toBe(false)
})

test('socket loss after the leader exited, with survivors holding the pipes, still kills them and exits 2 (review #1)', async () => {
  const { h, code } = await run(
    {
      graceMs: 300,
      script: `
        const { spawn } = require('child_process');
        const c = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); c.unref();
        require('fs').appendFileSync(process.env.SURVIVORS, c.pid + '\\n'); console.log(c.pid)`,
    },
    async (h) => {
      h.session.go()
      await vi.waitFor(() => expect(h.stdout.length).toBe(1))
      ;(h.session as unknown as { socket: net.Socket }).socket.destroy()
    },
  )
  expect(code).toBe(2)
  expect(alive(Number(h.stdout[0]))).toBe(false)
})

test('the disconnect budget holds after the leader exited, even when the payload cannot be emptied (review #1)', async () => {
  const h = await startHarness({
    graceMs: 200,
    script: `
      const { spawn } = require('child_process');
      const c = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); c.unref();
      require('fs').appendFileSync(process.env.SURVIVORS, c.pid + '\\n'); console.log(c.pid)`,
  })
  harnesses.push(h)
  const realKill = h.cgroup.killPayload.bind(h.cgroup)
  h.cgroup.killPayload = () => false // cgroup.kill unavailable: nothing can empty the payload
  await h.session.ready
  h.session.go()
  await vi.waitFor(() => expect(h.stdout.length).toBe(1))
  ;(h.session as unknown as { socket: net.Socket }).socket.destroy()
  const code = await Promise.race([
    h.done,
    new Promise<string>((r) => setTimeout(() => r('hung'), 9000)),
  ])
  h.cgroup.killPayload = realKill // test cleanup only: kills this test's own recorded survivor
  expect(code).toBe(2)
  expect(existsSync(join(h.receiptDir, 'ended.json'))).toBe(false)
}, 20_000)

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

test('#1: a pipe the supervisor had to close itself (a holder outside the payload) is loss, never a clean EOF', async () => {
  const { h, outcome, code } = await run({
    graceMs: 200,
    // The holder is not in the fake payload's survivors file, so the cgroup reports empty while the pipe stays open:
    // the cleanup closes Score's end of the pipes without an EOF having arrived.
    script: `
      const { spawn } = require('child_process');
      const c = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); c.unref();
      console.log(JSON.stringify({ type: 'first', holder: c.pid }))`,
  })
  const holder = Number(JSON.parse(h.stdout[0]!).holder)
  process.kill(holder, 'SIGKILL') // this test's own process
  expect(code).toBe(0)
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toEqual(
    expect.arrayContaining(['forced-eof-stdout', 'forced-eof-stderr']),
  )
  expect(outcome.droppedRecords).toBeGreaterThan(0)
})

test('backpressure that resumes delivers every unread byte (a consumer that catches up), and the result stays eligible', async () => {
  let behind = true
  const { h, outcome, code } = await run({
    graceMs: 200,
    // The socket looks backed up at first, then drains: the supervisor pauses the CLI's pipes and resumes them.
    connect: (path) => {
      const s = net.connect(path)
      Object.defineProperty(s, 'writableLength', { get: () => (behind ? 10_000_000 : 0) })
      setTimeout(() => {
        behind = false
        s.emit('drain')
      }, 250)
      return s
    },
    script: `
      console.log(JSON.stringify({ type: 'first' }));
      setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 300)`,
  })
  expect(code).toBe(0)
  expect(h.stdout.map((l) => JSON.parse(l).type)).toEqual(['first', 'turn.completed'])
  expect(outcome).toMatchObject({ eligible: true, reasons: [] })
})

test('a consumer that never catches up: output is either all delivered or the closure is forced and ineligible (re-review 2 test fix)', async () => {
  const { h, outcome, code } = await run({
    graceMs: 200,
    connect: (path) => {
      const s = net.connect(path)
      Object.defineProperty(s, 'writableLength', { get: () => 10_000_000 })
      return s
    },
    script: `
      console.log(JSON.stringify({ type: 'first' }));
      setTimeout(() => console.log(JSON.stringify({ type: 'turn.completed' })), 300)`,
  })
  expect(code).toBe(0)
  const delivered = h.stdout.map((l) => JSON.parse(l).type)
  if (delivered.length === 2) expect(outcome.eligible).toBe(true)
  else {
    // Unread output was thrown away by a forced close: never a clean end.
    expect(outcome.eligible).toBe(false)
    expect(outcome.reasons.some((r) => r.startsWith('forced-eof'))).toBe(true)
  }
})

test('re-review 2 #17: a deadline writes the first stop cause beside the receipts before any signal is sent', async () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'score-deadline-')), 'seen')
  const { h, outcome } = await run(
    {
      graceMs: 300,
      deadline: Date.now() + 400,
      script: `
        const fs=require('fs');
        process.on('SIGINT',()=>{ fs.writeFileSync(process.env.SEEN, String(fs.existsSync(process.env.STOP_RECEIPT))); process.exit(0) });
        console.log('up'); setInterval(()=>{}, 1000)`,
    },
    async (h) => {
      h.spec.command.env.SEEN = seen
      h.spec.command.env.STOP_RECEIPT = join(h.receiptDir, 'stop-cause.json')
      h.session.go()
    },
  )
  expect(readFileSync(seen, 'utf8')).toBe('true')
  expect(json(join(h.receiptDir, 'stop-cause.json'))).toMatchObject({
    launch: 'launch1',
    generation: 1,
    cause: 'deadline',
  })
  expect(outcome.stopCause).toBe('deadline')
})

test('re-review 2 #17: losing the socket writes a socket-loss cause; a stop that came from Score writes none', async () => {
  const lost = await run(
    { graceMs: 200, script: `console.log('up'); setInterval(()=>{}, 1000)` },
    async (h) => {
      h.session.go()
      await vi.waitFor(() => expect(h.stdout).toContain('up'))
      ;(h.session as unknown as { socket: net.Socket }).socket.destroy()
    },
  )
  expect(json(join(lost.h.receiptDir, 'stop-cause.json'))).toMatchObject({ cause: 'socket-loss' })
  const stopped = await run(
    { graceMs: 200, script: `console.log('up'); setInterval(()=>{}, 1000)` },
    async (h) => {
      h.session.go()
      await vi.waitFor(() => expect(h.stdout).toContain('up'))
      h.session.stop('user')
    },
  )
  // Score made `user` durable in its journal before sending it: the supervisor adds no receipt of its own.
  expect(receipts(stopped.h)).not.toContain('stop-cause.json')
})

test('re-review 2 #11: a deadline that arrives after `end` invalidates the candidate and reaches Score before the ack completes', async () => {
  const { h, outcome, code } = await run({
    graceMs: 200,
    deadline: Date.now() + 500,
    // Score is slow to save the last record, so the deadline falls between `end` and the acknowledgment.
    handlers: {
      onStdoutRecord: async () => {
        await new Promise((r) => setTimeout(r, 1200))
      },
    },
    script: `console.log(JSON.stringify({ type: 'turn.completed' }))`,
  })
  expect(outcome.kind).toBe('ended')
  expect(outcome.eligible).toBe(false)
  expect(outcome.reasons).toContain('supervisor-error:stop-after-end')
  // The supervisor does not leave with 0 as if nothing had happened.
  expect(code).toBe(1)
  expect(json(join(h.receiptDir, 'stop-cause.json'))).toMatchObject({ cause: 'deadline' })
})
