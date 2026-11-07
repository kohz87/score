import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { expect, test, vi } from 'vitest'
import { alive, receipts, startHarness } from '../helpers/coding-harness.ts'
import { harnesses, json, run, setupSupervisorTestLifecycle } from './coding-supervisor-helpers.ts'

setupSupervisorTestLifecycle()

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
