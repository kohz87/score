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
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
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

/** Writes a receipt O_EXCL + fsync + directory fsync (design section 3). Throws on any error: callers fail closed. */
export function writeReceipt(dir, name, body) {
  const fd = openSync(join(dir, name), 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify(body) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
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
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
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
  function requestStop(cause) {
    if (stopCause === null) stopCause = cause
    if (phase === 'waiting-go' || phase === 'connecting') {
      // Nothing has run, and nothing will: leave without a `released` receipt.
      endWithoutRun()
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
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

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
    stream.on('close', () => {
      if (eof[name]) return
      eof[name] = true
      send({ t: 'eof', stream: name, lastSeq: seq[name] })
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
    if (draining || !childExited || !eof.stdout || !eof.stderr) return
    draining = true
    phase = 'draining'
    const graceDeadline = now() + grace
    for (;;) {
      const state = cgroup.payloadState()
      if (state === 'empty' && cgroup.unitAlone()) break
      if (state !== 'empty' && !survivorsKilled && (stopCause !== null || now() >= graceDeadline)) {
        // A survivor outlived the CLI (a daemon, a setsid job): the cgroup is the only thing that still reaches it.
        survivorsKilled = true
        cgroup.killPayload()
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
    void (async () => {
      while (!(phase === 'ended' && childExited)) {
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
        send({
          t: 'ready',
          pid: process.pid,
          start: procStart(process.pid),
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
        } else requestStop('cancel')
        return
      case 'stop':
        requestStop(typeof f.cause === 'string' && f.cause.length <= 64 ? f.cause : 'stop')
        return
      case 'ack-end':
        if (phase === 'ended' && childExited) {
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
  runSupervisor(spec).then(
    (code) => process.exit(code),
    () => process.exit(EXIT.failed),
  )
}
