// The in-unit supervisor of a coding run (7.7a design v7 sections 1, 3, 4). Plain JavaScript, Node built-ins only: it
// runs as the main process of a transient systemd user unit, started by absolute node path with a minimal environment.
//
// Wire protocol (JSON lines, each <= 64 KB; the Score side is coding-socket.ts):
//   supervisor -> Score  hello{v,launch,generation,token,specHash}  ready{pid,start,cgroup}
//                        out{stream,seq,data(base64)}  eof{stream,lastSeq}  exit{code,signal}  end{}  error{code}
//   Score -> supervisor  welcome  reject{reason}  go  cancel  stop{cause}  ack-end
// Terminal order: eof (both streams) + exit, payload cgroup empty, `ended` receipt, `end`, Score's `ack-end`, exit 0.
// Any socket close other than after `ack-end` is socket loss: stop the CLI tree, wait for the payload to empty, exit 2.
import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 32 * 1024

/** Exit codes of the supervisor itself (the CLI's own code travels in the `exit` frame). */
export const EXIT = { ok: 0, failed: 1, socketLoss: 2, rejected: 3, badSpec: 4 }

/** Hash that binds a token to one spec: the spec without its token, as JSON in the file's key order. */
export function hashSpec(spec) {
  const rest = { ...spec }
  delete rest.token
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/** Start time (clock ticks since boot) of a process, from /proc; null when unreadable. */
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

/**
 * Writes a receipt so that the final name only ever holds a complete one (design section 3, review #8): the whole body
 * goes to a temp name (short writes looped), is fsynced, then linked to the final name (link fails when it already
 * exists, which keeps the old O_EXCL "exactly once" meaning; a plain rename would overwrite), the temp name is removed
 * and the directory is fsynced. Throws on any error: callers fail closed.
 */
export function writeReceipt(dir, name, body, io = {}) {
  const write = io.writeSync ?? writeSync
  const link = io.linkSync ?? linkSync
  const sync = io.fsyncSync ?? fsyncSync
  const final = join(dir, name)
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const data = Buffer.from(JSON.stringify(body) + '\n')
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let off = 0
      while (off < data.length) {
        const n = write(fd, data, off, data.length - off)
        if (!(n > 0)) throw new Error('receipt: short write')
        off += n
      }
      sync(fd)
    } finally {
      closeSync(fd)
    }
    link(tmp, final)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // never created, or already gone
    }
  }
  syncDirectory(dir, sync)
}

function syncDirectory(dir, sync = fsyncSync) {
  const dirFd = openSync(dir, 'r')
  try {
    sync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/**
 * Makes an EXISTING receipt durable: its contents and its directory entry are fsynced. A name that exists is not yet
 * proof that it survives a crash (the writer's directory sync may have failed), so a reader that finds `EEXIST` calls
 * this before it trusts the file. Throws on any error, including a missing file.
 */
export function syncReceipt(dir, name, io = {}) {
  const sync = io.fsyncSync ?? fsyncSync
  const fd = openSync(join(dir, name), 'r')
  try {
    sync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dir, sync)
}

/**
 * Replaces an existing receipt with a new body in one step (temp file, fsync, rename over the name, directory fsync). Used
 * for the final `acked.json`, whose `durable: true` form exists only once the directory sync of the first one succeeded.
 */
export function replaceReceipt(dir, name, body, io = {}) {
  const write = io.writeSync ?? writeSync
  const sync = io.fsyncSync ?? fsyncSync
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const data = Buffer.from(JSON.stringify(body) + '\n')
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let off = 0
      while (off < data.length) {
        const n = write(fd, data, off, data.length - off)
        if (!(n > 0)) throw new Error('receipt: short write')
        off += n
      }
      sync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, join(dir, name))
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // renamed away, or never created
    }
  }
  syncDirectory(dir, sync)
}

/**
 * Parses a receipt the way every reader must (review #8): an empty, partial, malformed or foreign one is `invalid`
 * and is never proof of anything. `kind` is 'released', 'ended' or 'acked'; `expect` pins the launch and generation.
 * Returns { state: 'present', body } | { state: 'invalid' }.
 */
export function parseReceipt(text, kind, expect = {}) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { state: 'invalid' }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { state: 'invalid' }
  if (typeof body.launch !== 'string' || body.launch === '') return { state: 'invalid' }
  if (!Number.isInteger(body.generation) || !Number.isFinite(body.at)) return { state: 'invalid' }
  if (expect.launch !== undefined && body.launch !== expect.launch) return { state: 'invalid' }
  if (expect.generation !== undefined && body.generation !== expect.generation)
    return { state: 'invalid' }
  if (kind === 'released') {
    if (!Number.isInteger(body.supervisorPid)) return { state: 'invalid' }
  } else if (kind === 'ended') {
    if (!('code' in body) || !('signal' in body) || typeof body.survivorsKilled !== 'boolean')
      return { state: 'invalid' }
  } else if (kind !== 'acked') return { state: 'invalid' }
  return { state: 'present', body }
}

/**
 * The real cgroup boundary: the unit's own cgroup (from /proc/self/cgroup) and its `payload/` child. Injected in tests
 * that run without systemd.
 */
export function systemdCgroup(root = '/sys/fs/cgroup') {
  const own = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .map((line) => /^0::(\/.*)$/.exec(line))
    .find(Boolean)?.[1]
  if (!own) throw new Error('not on cgroup v2')
  const unitDir = join(root, own)
  const payloadDir = join(unitDir, 'payload')
  return {
    /** The cgroup path reported in `ready` (relative to the cgroup root, as the kernel names it). */
    path: own,
    unitDir,
    payloadDir,
    prepare() {
      mkdirSync(payloadDir, { recursive: false })
      return payloadDir
    },
    /** 'empty' | 'populated' | 'unknown'. `populated` is recursive, so it covers descendants and setsid survivors. */
    payloadState() {
      try {
        const m = /^populated (\d)$/m.exec(readFileSync(join(payloadDir, 'cgroup.events'), 'utf8'))
        return m ? (m[1] === '0' ? 'empty' : 'populated') : 'unknown'
      } catch {
        return 'unknown'
      }
    },
    /** True when the unit cgroup holds nothing but the supervisor itself (and its payload subgroup is not counted). */
    unitAlone() {
      try {
        const pids = readFileSync(join(unitDir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)
        return pids.every((p) => p === String(process.pid))
      } catch {
        return false
      }
    },
    /** cgroup.kill (kernel 5.14+) kills every process of the payload atomically; false when unavailable. */
    killPayload() {
      try {
        writeFileSync(join(payloadDir, 'cgroup.kill'), '1')
        return true
      } catch {
        return false
      }
    },
  }
}

function notifyWatchdog(spec) {
  if (!spec.notifyBin) return () => undefined
  let pending = false
  return () => {
    if (pending) return
    pending = true
    // systemd-notify is spawned from the control loop (design section 1): a hung loop stops pinging.
    execFile(spec.notifyBin, ['WATCHDOG=1'], { timeout: 2000, env: process.env }, () => {
      pending = false
    })
  }
}

/**
 * Runs one supervised launch to its end and resolves with the supervisor's exit code.
 * `deps` (all optional) lets tests inject the cgroup boundary, the socket connection, the clock and the watchdog.
 */
export async function runSupervisor(spec, deps = {}) {
  const now = deps.now ?? Date.now
  const grace = spec.graceMs
  const tickMs = spec.tickMs ?? 250
  const watchdogMs = spec.watchdogMs ?? 3000
  const limits = {
    highWaterBytes: 256 * 1024,
    maxStreamBytes: 64 * 1024 * 1024,
    maxRunBytes: 128 * 1024 * 1024,
    ...spec.limits,
  }
  const cgroup = deps.cgroup ?? systemdCgroup()
  const watchdog = deps.watchdog ?? notifyWatchdog(spec)

  const sock = deps.connect ? deps.connect(spec.socket) : net.connect(spec.socket)
  let socketOpen = true
  const send = (frame) => {
    if (!socketOpen || sock.destroyed) return false
    const line = JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) + '\n'
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('frame too large')
    sock.write(line)
    return true
  }

  // ---- state
  let phase = 'connecting' // connecting | waiting-go | running | draining | ended
  let stopCause = null
  let child = null
  let childExited = false
  let exitInfo = null
  let survivorsKilled = false
  let escalating = false
  let lastWatchdog = now()
  let payloadDir = null
  const seq = { stdout: 0, stderr: 0 }
  const eof = { stdout: false, stderr: false }
  // A pipe Score closed itself (cleanup, read error) is loss, never a clean EOF (review 2026-10-12 #1): unread output
  // may have been thrown away, so the `eof` frame says so and the result is ineligible.
  const forced = { stdout: false, stderr: false }
  const bytes = { stdout: 0, stderr: 0 }
  let paused = false
  let finished = false
  let capExceeded = false

  let resolveDone
  const done = new Promise((r) => (resolveDone = r))
  const finish = (code) => {
    if (finished) return
    finished = true
    clearInterval(timer)
    detachSignals()
    sock.destroy()
    resolveDone(code)
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitChildExit = (ms) =>
    new Promise((resolve) => {
      if (!child || childExited) return resolve(true)
      const t = setTimeout(() => resolve(false), ms)
      child.once('exit', () => {
        clearTimeout(t)
        resolve(true)
      })
    })

  const signalTree = (sig) => {
    // The CLI is our direct child and its own group leader (detached); the group stays ours until the leader is reaped.
    if (!child || childExited || child.pid === undefined) return
    try {
      process.kill(-child.pid, sig)
    } catch {
      // already gone
    }
  }

  // ---- stop and escalation: INT -> TERM -> KILL, one grace each, every signal exactly once (design section 1)
  // The first cause of a stop the supervisor starts itself (deadline, socket loss, systemd's stop) is written beside the
  // other receipts BEFORE anything is signalled, so a Score that restarts, or a run that dies before its `ended` receipt,
  // still knows why it was stopped (review 2026-10-12 #17). The first cause wins (`link` refuses a second file). A cause
  // that couldn't be written is told to Score as an error frame and stays uncertainty on its side.
  let stopRecorded = false
  function recordStopCause(cause) {
    if (stopRecorded) return
    stopRecorded = true
    try {
      writeReceipt(spec.receiptDir, 'stop-cause.json', {
        launch: spec.launch,
        generation: spec.generation,
        at: now(),
        cause,
      })
    } catch (error) {
      // EEXIST: an earlier pass already holds the first cause.
      if (error?.code !== 'EEXIST') send({ t: 'error', code: 'stop-unrecorded' })
    }
  }
  // A stop that arrives after `end` went out (a deadline while Score finishes ingesting, systemd's stop, socket trouble):
  // the terminal candidate is no longer clean. Score hears about it before the acknowledgment can complete, and this
  // supervisor then leaves with a failure status instead of 0 (review 2026-10-12 #11).
  let stoppedAfterEnd = false

  // `fromScore`: the stop came over the wire; Score made its cause durable before sending it, so no receipt of ours.
  function requestStop(cause, fromScore = false) {
    if (stopCause === null) stopCause = cause
    if (phase === 'waiting-go' || phase === 'connecting') {
      // Nothing has run, and nothing will: leave without a `released` receipt.
      endWithoutRun()
      return
    }
    if (!fromScore) recordStopCause(stopCause)
    if (phase === 'ended' && !finished) {
      if (!stoppedAfterEnd) {
        stoppedAfterEnd = true
        send({ t: 'error', code: 'stop-after-end' })
      }
      return
    }
    if (escalating || childExited || !child) return
    escalating = true
    void (async () => {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
        signalTree(sig)
        if (await waitChildExit(grace)) return
      }
    })()
  }

  function endWithoutRun() {
    phase = 'ended'
    // The payload cgroup exists but nothing was started in it, so there is nothing to wait for.
    finish(
      stopCause === 'cancel' ? EXIT.ok : stopCause === 'socket-loss' ? EXIT.socketLoss : EXIT.ok,
    )
  }

  const onSignal = () => requestStop('unit-stop')
  // systemd's stop reaches the supervisor as SIGINT (KillMode=mixed). `deps.onUnitStop` replaces the process signals
  // in tests that run the supervisor inside the test process.
  const detachSignals = deps.onUnitStop
    ? (deps.onUnitStop(onSignal) ?? (() => undefined))
    : (() => {
        process.on('SIGINT', onSignal)
        process.on('SIGTERM', onSignal)
        return () => {
          process.off('SIGINT', onSignal)
          process.off('SIGTERM', onSignal)
        }
      })()

  // ---- output
  const pauseOutput = () => {
    if (paused || !child) return
    paused = true
    child.stdout?.pause()
    child.stderr?.pause()
  }
  const resumeOutput = () => {
    if (!paused) return
    paused = false
    child?.stdout?.resume()
    child?.stderr?.resume()
  }
  sock.on('drain', () => {
    if (sock.writableLength < limits.highWaterBytes / 2) resumeOutput()
  })

  function pump(stream, name) {
    stream.on('data', (chunk) => {
      if (capExceeded) return
      bytes[name] += chunk.length
      if (bytes[name] > limits.maxStreamBytes || bytes.stdout + bytes.stderr > limits.maxRunBytes) {
        capExceeded = true
        send({ t: 'error', code: 'output-cap' })
        requestStop('output-cap')
        return
      }
      for (let off = 0; off < chunk.length; off += MAX_CHUNK_BYTES) {
        const part = chunk.subarray(off, off + MAX_CHUNK_BYTES)
        seq[name] += 1
        send({ t: 'out', stream: name, seq: seq[name], data: part.toString('base64') })
      }
      // Backpressure (design section 4): stop reading the CLI's pipes while the socket buffer is high; the CLI blocks.
      if (sock.writableLength > limits.highWaterBytes) pauseOutput()
    })
    stream.on('error', () => {
      forced[name] = true
    })
    stream.on('close', () => {
      if (eof[name]) return
      eof[name] = true
      send({
        t: 'eof',
        stream: name,
        lastSeq: seq[name],
        ...(forced[name] ? { forced: true } : {}),
      })
      void maybeDrained()
    })
  }

  // ---- starting the CLI (after `go`)
  function startCli() {
    const cmd = spec.command
    try {
      // Receipt first: `released` means the CLI may have executed (design section 3). Any error fails closed.
      writeReceipt(spec.receiptDir, 'released.json', {
        launch: spec.launch,
        generation: spec.generation,
        at: now(),
        supervisorPid: process.pid,
      })
    } catch {
      send({ t: 'error', code: 'receipt' })
      phase = 'ended'
      finish(EXIT.failed)
      return
    }
    const useWrapper = Boolean(spec.python && spec.wrapper)
    const file = useWrapper ? spec.python : cmd.file
    const args = useWrapper
      ? [
          '-I',
          spec.wrapper,
          String(process.pid),
          '3',
          ...(payloadDir ? ['--cgroup', payloadDir] : []),
          '--',
          cmd.file,
          ...cmd.args,
        ]
      : cmd.args
    phase = 'running'
    try {
      child = spawn(file, args, {
        cwd: cmd.cwd,
        env: cmd.env,
        stdio: ['pipe', 'pipe', 'pipe', ...(useWrapper ? ['pipe'] : [])],
        detached: true,
      })
    } catch {
      send({ t: 'error', code: 'spawn' })
      phase = 'ended'
      finish(EXIT.failed)
      return
    }
    child.on('error', () => {
      if (!childExited) {
        childExited = true
        exitInfo = { code: null, signal: null, spawnFailed: true }
        send({ t: 'error', code: 'spawn' })
        for (const name of ['stdout', 'stderr']) {
          if (!eof[name]) {
            eof[name] = true
            send({ t: 'eof', stream: name, lastSeq: seq[name] })
          }
        }
        send({ t: 'exit', code: null, signal: null })
        void maybeDrained()
      }
    })
    child.stdin.on('error', () => undefined)
    if (cmd.stdin != null) child.stdin.end(cmd.stdin)
    else child.stdin.end()
    pump(child.stdout, 'stdout')
    pump(child.stderr, 'stderr')
    child.on('exit', (code, signal) => {
      childExited = true
      exitInfo = { code, signal }
      send({ t: 'exit', code, signal })
      void maybeDrained()
    })
    if (useWrapper) {
      const gate = child.stdio[3]
      gate.on('error', () => undefined)
      gate.end('g')
    }
  }

  // ---- end of the run: payload empty, receipt, `end`
  let draining = false
  async function maybeDrained() {
    // Cleanup runs once the leader has exited, whether or not the pipes have reached EOF: a survivor that keeps the
    // CLI's stdout/stderr open must not delay killing the payload (review #1).
    if (draining || !childExited) return
    draining = true
    phase = 'draining'
    const graceDeadline = now() + grace
    let emptySince = null
    for (;;) {
      const state = cgroup.payloadState()
      if (state === 'empty' && cgroup.unitAlone()) {
        if (eof.stdout && eof.stderr) break
        // Nothing left in the payload can hold a pipe open; if EOF still has not arrived, close our ends.
        emptySince ??= now()
        if (now() - emptySince >= grace)
          for (const name of ['stdout', 'stderr'])
            if (!eof[name]) {
              forced[name] = true
              child?.[name]?.destroy()
            }
      } else {
        emptySince = null
        if (!survivorsKilled && (stopCause !== null || now() >= graceDeadline)) {
          // A survivor outlived the CLI (a daemon, a setsid job): the cgroup is the only thing that still reaches it.
          // Retried while the kill is unavailable or has not emptied the cgroup.
          survivorsKilled = cgroup.killPayload()
        } else if (survivorsKilled && now() >= graceDeadline + grace) {
          cgroup.killPayload()
        }
      }
      await sleep(deps.pollMs ?? spec.pollMs ?? 50)
      if (finished) return
    }
    try {
      writeReceipt(spec.receiptDir, 'ended.json', {
        launch: spec.launch,
        generation: spec.generation,
        at: now(),
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        stopCause,
        survivorsKilled,
      })
    } catch {
      send({ t: 'error', code: 'receipt' })
      finish(EXIT.failed)
      return
    }
    phase = 'ended'
    send({ t: 'end', survivorsKilled, stopCause })
  }

  // ---- control loop: deadline, then the watchdog ping, in that order, so a stuck loop stops pinging
  const timer = setInterval(() => {
    if (finished) return
    if (stopCause === null && now() >= spec.deadline) requestStop('deadline')
    if (now() - lastWatchdog >= watchdogMs) {
      lastWatchdog = now()
      watchdog()
    }
  }, tickMs)

  // ---- socket
  let buffer = ''
  sock.setEncoding('utf8')
  sock.on('data', (text) => {
    buffer += text
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl < 0) break
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      handleFrame(line)
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) onLoss()
  })
  const onLoss = () => {
    if (!socketOpen) return
    socketOpen = false
    sock.destroy()
    if (finished) return
    if (phase === 'connecting' || phase === 'waiting-go') {
      stopCause ??= 'socket-loss'
      phase = 'ended'
      finish(EXIT.socketLoss)
      return
    }
    // Socket loss: stop the CLI tree, wait for the payload to empty (maybeDrained), then exit 2.
    stopCause ??= 'socket-loss'
    requestStop('socket-loss')
    // Disconnect budget (design section 1): 2 x grace + 5 s from the loss, leader exit or not. Past it the supervisor
    // exits anyway, and systemd's stop then kills whatever the cgroup still holds.
    const lossDeadline = now() + (spec.disconnectBudgetMs ?? 2 * grace + 5000)
    void (async () => {
      while (!(phase === 'ended' && childExited) && now() < lossDeadline) {
        await sleep(deps.pollMs ?? spec.pollMs ?? 50)
        if (finished) return
      }
      finish(EXIT.socketLoss)
    })()
  }
  sock.on('close', onLoss)
  sock.on('error', () => undefined)

  function handleFrame(line) {
    let f
    try {
      f = JSON.parse(line)
    } catch {
      return onLoss()
    }
    if (f === null || typeof f !== 'object') return onLoss()
    switch (f.t) {
      case 'welcome':
        if (phase !== 'connecting') return
        try {
          payloadDir = cgroup.prepare()
        } catch {
          send({ t: 'error', code: 'cgroup' })
          phase = 'ended'
          finish(EXIT.failed)
          return
        }
        phase = 'waiting-go'
        // `deps.self` lets tests that run the supervisor inside the test process report a distinct identity.
        send({
          t: 'ready',
          pid: deps.self?.pid ?? process.pid,
          start: deps.self?.start ?? procStart(process.pid),
          cgroup: cgroup.path,
        })
        return
      case 'reject':
        stopCause = 'rejected'
        phase = 'ended'
        finish(EXIT.rejected)
        return
      case 'go':
        if (phase === 'waiting-go') startCli()
        return
      case 'cancel':
        if (phase === 'waiting-go' || phase === 'connecting') {
          stopCause = 'cancel'
          endWithoutRun()
        } else requestStop('cancel', true)
        return
      case 'stop':
        requestStop(typeof f.cause === 'string' && f.cause.length <= 64 ? f.cause : 'stop', true)
        return
      case 'ack-end':
        if (phase === 'ended' && childExited) {
          if (stoppedAfterEnd) {
            finish(EXIT.failed)
            return
          }
          // The final receipt: written after `ack-end` was READ, before the clean exit. Score treats a run as normally
          // completed only with this file and a clean exit; without the unit's exit metadata (a replaced manager) only a
          // receipt carrying `durable: true` stands in, and that form exists only once the directory sync succeeded. A
          // receipt whose publication failed is removed again before exiting non-zero, so its name is never left behind.
          const body = { launch: spec.launch, generation: spec.generation, at: now() }
          try {
            try {
              writeReceipt(spec.receiptDir, 'acked.json', body, deps.receiptIo)
            } catch (error) {
              // An earlier writer's name: take it over and make it durable below (or fail).
              if (error?.code !== 'EEXIST') throw error
            }
            replaceReceipt(
              spec.receiptDir,
              'acked.json',
              { ...body, durable: true },
              deps.receiptIo,
            )
          } catch {
            try {
              unlinkSync(join(spec.receiptDir, 'acked.json'))
              syncDirectory(spec.receiptDir)
            } catch {
              // nothing more can be done; the exit below is non-zero
            }
            finish(EXIT.failed)
            return
          }
          finish(EXIT.ok)
        }
        return
      default:
        return
    }
  }

  const sendHello = () =>
    send({
      t: 'hello',
      launch: spec.launch,
      generation: spec.generation,
      token: spec.token,
      specHash: hashSpec(spec),
    })
  if (deps.connect) sendHello()
  else sock.once('connect', sendHello)

  return done
}

const REQUIRED = [
  'launch',
  'generation',
  'token',
  'socket',
  'receiptDir',
  'command',
  'graceMs',
  'deadline',
]

function loadSpec(path) {
  const spec = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of REQUIRED) if (spec[key] === undefined) throw new Error(`spec: missing ${key}`)
  const c = spec.command
  if (typeof c?.file !== 'string' || !c.file.startsWith('/') || !Array.isArray(c.args))
    throw new Error('spec: bad command')
  if (!Number.isFinite(spec.graceMs) || spec.graceMs < 0) throw new Error('spec: bad graceMs')
  if (!existsSync(spec.receiptDir)) throw new Error('spec: receipt directory missing')
  return spec
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let spec
  try {
    spec = loadSpec(process.argv[2])
  } catch {
    process.exit(EXIT.badSpec)
  }
  // The spec holds the single-use token: delete it right after reading, before `hello` (lead answer, part 3). Score
  // deletes it again on `ready` or settlement as a backstop.
  try {
    unlinkSync(process.argv[2])
  } catch {
    // Score's backstop removes it
  }
  runSupervisor(spec).then(
    (code) => process.exit(code),
    () => process.exit(EXIT.failed),
  )
}
