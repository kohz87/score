import { spawn } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { signalTree, waitChildExit } from './supervisor-child.mjs'
import { systemdCgroup } from './supervisor-cgroup.mjs'
import { createDrain } from './supervisor-drain.mjs'
import { createFrameHandler } from './supervisor-frames.mjs'
import { createOutputPump } from './supervisor-output.mjs'
import { EXIT, MAX_FRAME_BYTES, PROTOCOL_VERSION, hashSpec } from './supervisor-protocol.mjs'
import { replaceReceipt, syncDirectory, writeReceipt } from './supervisor-receipts.mjs'
import { notifyWatchdog } from './supervisor-watchdog.mjs'

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
        signalTree(child, childExited, sig)
        if (await waitChildExit(child, childExited, grace)) return
      }
    })()
  }

  // The `expired` receipt says why no `released` receipt exists. The launch stays released in Score's journal (the
  // release was durable before `go`); the receipts are what prove the CLI never spawned.
  function expireBeforeSpawn() {
    stopCause ??= 'deadline'
    try {
      writeReceipt(spec.receiptDir, 'expired.json', {
        launch: spec.launch,
        generation: spec.generation,
        at: now(),
      })
    } catch {
      // A receipt that can't be written leaves the launch unproven on Score's side, which is the safe answer.
    }
    send({ t: 'error', code: 'expired' })
    endWithoutRun()
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
    // The receipt's fsyncs block, and the clock moves while they do: check the absolute expiry once more, after the
    // receipt is durable and right before the spawn (F1 #3). `released.json` stays (Score keeps the launch as possibly
    // executed and its step charge); `expired.json` says the CLI never started.
    if (now() >= spec.deadline) return expireBeforeSpawn()
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
  const maybeDrained = createDrain({
    cgroup,
    deps,
    spec,
    now,
    grace,
    send,
    finish,
    EXIT,
    writeReceipt,
    sleep,
    eof,
    forced,
    get child() {
      return child
    },
    get childExited() {
      return childExited
    },
    get draining() {
      return draining
    },
    set draining(value) {
      draining = value
    },
    get exitInfo() {
      return exitInfo
    },
    get finished() {
      return finished
    },
    get phase() {
      return phase
    },
    set phase(value) {
      phase = value
    },
    get stopCause() {
      return stopCause
    },
    get survivorsKilled() {
      return survivorsKilled
    },
    set survivorsKilled(value) {
      survivorsKilled = value
    },
  })
  const pump = createOutputPump({
    bytes,
    eof,
    forced,
    limits,
    maybeDrained,
    pauseOutput,
    requestStop,
    send,
    seq,
    sock,
    get capExceeded() {
      return capExceeded
    },
    set capExceeded(value) {
      capExceeded = value
    },
  })

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
  const handleFrame = createFrameHandler({
    cgroup,
    send,
    finish,
    EXIT,
    deps,
    spec,
    now,
    expireBeforeSpawn,
    startCli,
    endWithoutRun,
    requestStop,
    onLoss,
    writeReceipt,
    replaceReceipt,
    unlinkSync,
    join,
    syncDirectory,
    get phase() {
      return phase
    },
    set phase(value) {
      phase = value
    },
    get stopCause() {
      return stopCause
    },
    set stopCause(value) {
      stopCause = value
    },
    get payloadDir() {
      return payloadDir
    },
    set payloadDir(value) {
      payloadDir = value
    },
    get childExited() {
      return childExited
    },
    get stoppedAfterEnd() {
      return stoppedAfterEnd
    },
    set stoppedAfterEnd(value) {
      stoppedAfterEnd = value
    },
  })
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
  sock.on('close', onLoss)
  sock.on('error', () => undefined)

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
