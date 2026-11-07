import net from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import {
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  QUEUE_ENTRY_OVERHEAD_BYTES,
  SupervisorFrame,
  type Budget,
  type ReadyInfo,
  type RunHandlers,
  type SessionOutcome,
  type SocketLimits,
} from './coding-socket-types.ts'

/** One launch's connection: Score drives it with go/cancel/stop/ackEnd-by-protocol and reads its outcome. */
export class RunSession {
  /** Resolves when the supervisor reported its identity; rejects when the connection ended before. */
  readonly ready: Promise<ReadyInfo>
  /** Resolves once, when the connection is over (after ack-end, or on loss). Never rejects. */
  readonly outcome: Promise<SessionOutcome>

  private socket: net.Socket | null = null
  private lineBuffer = ''
  private resolveReady!: (info: ReadyInfo) => void
  private rejectReady!: (error: Error) => void
  private resolveOutcome!: (outcome: SessionOutcome) => void
  private settled = false
  private readySeen = false

  private readonly lastSeq = { stdout: 0, stderr: 0 }
  private readonly eofSeen = { stdout: false, stderr: false }
  private readonly bytes = { stdout: 0, stderr: 0 }
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  private stdoutPartial = ''
  /** Budget bytes charged for `stdoutPartial` (released and recharged as it changes). */
  private partialCharge = 0
  private skippingOversize = false
  private stderrKept = 0
  private exitInfo: { code: number | null; signal: string | null } | null = null
  private endFrame: Extract<SupervisorFrame, { t: 'end' }> | null = null
  private ackSent = false
  private ackFlushed = false
  private violations: string[] = []
  private dropped = 0
  private ingestFailed = false
  private queue: string[] = []
  private queueBytes = 0
  private pumping = false
  private readPaused = false
  private lastStopCause: string | null = null

  /** @internal */
  constructor(
    readonly launch: string,
    readonly generation: number,
    private readonly handlers: RunHandlers,
    private readonly limits: SocketLimits,
    private readonly budget: Budget,
    /** Bytes charged to the budget for what the run retains; grows with the parser's actual retained bytes. */
    private readonly reservation: { bytes: number; floor: number; released?: boolean } = {
      bytes: 0,
      floor: 0,
    },
  ) {
    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this.outcome = new Promise<SessionOutcome>((resolve) => {
      this.resolveOutcome = resolve
    })
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  /** Releases the CLI (after the journal's `releasing` commit, design section 3). */
  go(): void {
    this.send({ t: 'go' })
  }

  /** The launch will not run: only valid before `go`. */
  cancel(): void {
    this.send({ t: 'cancel' })
  }

  /** Starts the supervisor's INT -> TERM -> KILL escalation; the first cause wins on its side. */
  stop(cause: string): void {
    this.lastStopCause ??= cause
    this.send({ t: 'stop', cause })
  }

  /** @internal Attaches the authenticated connection and starts reading its frames. */
  attach(socket: net.Socket, leftover: string): void {
    this.socket = socket
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.onClose())
    socket.on('error', () => undefined)
    this.send({ t: 'welcome' })
    if (leftover) this.onData(leftover)
  }

  /** @internal Shutdown: tell the supervisor to stop, then destroy the socket once the frame is flushed. */
  shutdown(sendStop = true): Promise<void> {
    return new Promise((resolve) => {
      const socket = this.socket
      if (!socket || socket.destroyed) return resolve()
      socket.once('close', () => resolve())
      // Held (re-review 6 #5): the socket is simply dropped; the supervisor's own disconnect containment ends the CLI.
      if (!sendStop) return void socket.destroy()
      const line =
        JSON.stringify({ v: PROTOCOL_VERSION, t: 'stop', cause: 'score-shutdown' }) + '\n'
      this.noteStop('score-shutdown')
      socket.write(line, () => socket.destroy())
      setTimeout(() => socket.destroy(), 1000).unref()
    })
  }

  private send(frame: Record<string, unknown>, flushed?: (ok: boolean) => void): void {
    const socket = this.socket
    if (!socket || socket.destroyed) return flushed?.(false)
    socket.write(
      JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) + '\n',
      flushed ? (error) => flushed(!error) : undefined,
    )
  }

  /** Makes Score's own stop cause durable before the frame is sent; a failing hook never blocks the stop. */
  private noteStop(cause: string): void {
    try {
      this.handlers.onStop?.(cause)
    } catch {
      // the hook reports its own failure; stopping matters more than the note
    }
  }

  private violate(reason: string): void {
    if (!this.violations.includes(reason)) this.violations.push(reason)
    // A bound was broken or the stream is inconsistent: stop the run (once); the result is ineligible.
    if (this.lastStopCause === null) {
      this.noteStop(reason.slice(0, 64))
      this.send({ t: 'stop', cause: reason.slice(0, 64) })
    }
    this.lastStopCause ??= reason
  }

  private onData(chunk: string): void {
    this.lineBuffer += chunk
    for (;;) {
      const nl = this.lineBuffer.indexOf('\n')
      if (nl < 0) break
      const line = this.lineBuffer.slice(0, nl)
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.protocolError('frame-too-large')
      this.onLine(line)
    }
    if (Buffer.byteLength(this.lineBuffer) > MAX_FRAME_BYTES) this.protocolError('frame-too-large')
  }

  private protocolError(reason: string): void {
    this.violations.push(reason)
    this.socket?.destroy()
  }

  private onLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return this.protocolError('bad-frame')
    }
    const parsed = SupervisorFrame.safeParse(raw)
    if (!parsed.success) return this.protocolError('bad-frame')
    const f = parsed.data
    // Terminal order (design section 4): nothing follows `end`, and `end` follows both EOFs and the exit.
    if (this.endFrame && f.t !== 'error') return this.protocolError('frame-after-end')
    switch (f.t) {
      case 'hello':
        return this.protocolError('duplicate-hello')
      case 'ready':
        if (this.readySeen) return this.protocolError('duplicate-ready')
        this.readySeen = true
        this.resolveReady({ pid: f.pid, start: f.start, cgroup: f.cgroup })
        return
      case 'out':
        return this.onOut(f.stream, f.seq, f.data)
      case 'eof':
        return this.onEof(f.stream, f.lastSeq, f.forced === true)
      case 'exit':
        if (this.exitInfo) return this.protocolError('duplicate-exit')
        this.exitInfo = { code: f.code, signal: f.signal }
        return
      case 'end':
        return this.onEnd(f)
      case 'error':
        this.violate(`supervisor-error:${f.code}`)
        return
    }
  }

  private onOut(stream: 'stdout' | 'stderr', seq: number, data: string): void {
    if (this.eofSeen[stream]) return this.protocolError('out-after-eof')
    if (seq !== this.lastSeq[stream] + 1) {
      // A gap or a repeat means chunks were lost or duplicated: nothing after it can be trusted.
      return this.violate(`seq-${stream}`)
    }
    this.lastSeq[stream] = seq
    const raw = Buffer.from(data, 'base64')
    if (raw.length > MAX_CHUNK_BYTES) return this.protocolError('chunk-too-large')
    this.bytes[stream] += raw.length
    if (
      this.bytes[stream] > this.limits.maxStreamBytes ||
      this.bytes.stdout + this.bytes.stderr > this.limits.maxRunBytes
    ) {
      return this.violate('run-cap')
    }
    const text = this.decoders[stream].write(raw)
    if (stream === 'stdout') this.takeStdout(text)
    else this.takeStderr(text)
  }

  private takeStdout(text: string): void {
    let rest = this.stdoutPartial + text
    this.stdoutPartial = ''
    this.chargePartial(0)
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl < 0) break
      const line = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      if (this.skippingOversize) {
        this.skippingOversize = false
        continue
      }
      this.enqueue(line)
    }
    if (this.skippingOversize) return
    if (Buffer.byteLength(rest) > this.limits.maxRecordBytes) {
      // Over the per-line allowance: a dropped record, skipped up to its newline, and the run is stopped (design 4).
      this.dropped += 1
      this.skippingOversize = true
      return this.violate('record-too-large')
    }
    // The partial line is buffered text like any other: it counts against the installation-wide budget.
    const size = Buffer.byteLength(rest)
    if (this.budget.used + size > this.budget.limit) {
      this.dropped += 1
      this.skippingOversize = true
      return this.violate('memory-budget')
    }
    this.stdoutPartial = rest
    this.chargePartial(size)
  }

  private chargePartial(size: number): void {
    this.budget.used += size - this.partialCharge
    this.partialCharge = size
  }

  private takeStderr(text: string): void {
    if (!text) return
    const room = this.limits.maxStderrKeptBytes - this.stderrKept
    if (room <= 0) return
    const kept =
      Buffer.byteLength(text) <= room ? text : Buffer.from(text).subarray(0, room).toString('utf8')
    this.stderrKept += Buffer.byteLength(kept)
    this.handlers.onStderr?.(kept)
    // Diagnostics are retained text too (FU #8).
    this.chargeRetained()
  }

  private enqueue(line: string): void {
    const text = Buffer.byteLength(line)
    if (text > this.limits.maxRecordBytes) {
      this.dropped += 1
      return this.violate('record-too-large')
    }
    const size = text + QUEUE_ENTRY_OVERHEAD_BYTES
    if (this.budget.used + size > this.budget.limit) {
      this.dropped += 1
      return this.violate('memory-budget')
    }
    this.budget.used += size
    this.queueBytes += size
    this.queue.push(line)
    if (this.queueBytes >= this.limits.pauseBytes && !this.readPaused) {
      // Real backpressure: stop reading, so the supervisor's socket buffer fills and it pauses the CLI's pipes.
      this.readPaused = true
      this.socket?.pause()
    }
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const line = this.queue.shift()!
        const size = Buffer.byteLength(line) + QUEUE_ENTRY_OVERHEAD_BYTES
        try {
          await this.handlers.onStdoutRecord(line)
        } catch {
          if (!this.ingestFailed) {
            this.ingestFailed = true
            if (this.lastStopCause === null) this.noteStop('ingest-failure')
            this.lastStopCause ??= 'ingest-failure'
            this.send({ t: 'stop', cause: 'ingest-failure' })
          }
        }
        this.queueBytes -= size
        this.budget.used -= size
        this.chargeRetained()
        if (this.readPaused && this.queueBytes <= this.limits.pauseBytes / 2) {
          this.readPaused = false
          this.socket?.resume()
        }
      }
    } finally {
      this.pumping = false
    }
    void this.maybeComplete()
  }

  private onEof(stream: 'stdout' | 'stderr', lastSeq: number, forced: boolean): void {
    if (this.eofSeen[stream]) return this.protocolError('duplicate-eof')
    this.eofSeen[stream] = true
    // A pipe the supervisor had to close itself is loss, not an end of stream (review 2026-10-12 #1).
    if (forced) {
      this.dropped += 1
      this.violate(`forced-eof-${stream}`)
    }
    if (lastSeq !== this.lastSeq[stream]) this.violate(`eof-seq-${stream}`)
    const tail = this.decoders[stream].end()
    if (stream === 'stdout') {
      const rest = this.stdoutPartial + tail
      this.stdoutPartial = ''
      this.chargePartial(0)
      // A partial last stdout line is a dropped record (lossy); stderr's partial line is just text.
      if (rest.length > 0 && !this.skippingOversize) this.dropped += 1
      this.skippingOversize = false
    } else this.takeStderr(tail)
  }

  private onEnd(f: Extract<SupervisorFrame, { t: 'end' }>): void {
    if (this.endFrame) return this.protocolError('duplicate-end')
    // `end` before both EOFs and the exit is out of order: never acknowledged, and the connection is dropped.
    if (!this.eofSeen.stdout || !this.eofSeen.stderr || !this.exitInfo)
      return this.protocolError('end-before-eof')
    this.endFrame = f
    void this.maybeComplete()
  }

  /** `end` seen: wait until every stdout record is processed, then acknowledge (design section 4, terminal order). */
  private async maybeComplete(): Promise<void> {
    if (!this.endFrame || this.ackSent || this.pumping || this.queue.length > 0) return
    this.ackSent = true
    // Queued is not delivered: only a completed write makes the acknowledgment something the supervisor can have seen.
    this.send({ t: 'ack-end' }, (ok) => {
      this.ackFlushed = ok
    })
  }

  /**
   * Charges what the run really retains (the parser's values, which can far exceed any entry count) instead of a fixed
   * reservation. Past the installation budget the run is stopped and ineligible (review 2026-10-12 #18).
   */
  private chargeRetained(): void {
    // A record still being ingested when the socket was lost finishes after the launch's reservation was released:
    // nothing would ever release a new charge, so a released reservation is never charged again (S5-C01).
    if (this.reservation.released) return
    const actual = this.handlers.retainedBytes?.()
    if (actual === undefined || !Number.isFinite(actual)) return
    const target = Math.max(this.reservation.floor, Math.ceil(actual))
    const delta = target - this.reservation.bytes
    const over = delta > 0 && this.budget.used + delta > this.budget.limit
    // The parser really holds these bytes whether or not they fit: they stay charged (as debt, past the limit) until the
    // state is cleared, so other runs can't be admitted on top of memory that is already in use (FV #3).
    if (delta !== 0) {
      this.budget.used += delta
      this.reservation.bytes = target
    }
    if (over) {
      this.dropped += 1
      this.violate('memory-budget')
    }
  }

  private reasons(): string[] {
    const reasons = [...this.violations]
    if (!this.eofSeen.stdout || !this.eofSeen.stderr) reasons.push('missing-eof')
    if (!this.exitInfo) reasons.push('missing-exit')
    if (this.dropped > 0) reasons.push('dropped-record')
    if (this.ingestFailed) reasons.push('ingest-failure')
    if (this.endFrame?.stopCause) reasons.push(`stop-cause:${this.endFrame.stopCause}`)
    else if (this.lastStopCause) reasons.push(`stop-cause:${this.lastStopCause}`)
    return reasons
  }

  private onClose(): void {
    if (this.settled) return
    this.settled = true
    if (this.readPaused) this.readPaused = false
    // Close after ack-end is the normal end; any other close is socket loss.
    const ended = this.ackSent && this.endFrame !== null
    if (!this.readySeen) this.rejectReady(new Error('connection closed before ready'))
    const reasons = ended ? this.reasons() : [...this.reasons(), 'socket-loss']
    // Normal only when the acknowledgment was actually written: a lost ack means the supervisor saw a closed socket.
    if (ended && !this.ackFlushed) reasons.push('ack-not-flushed')
    // Closing with records still queued or being ingested means output was acknowledged or counted before it was saved.
    if (this.pumping || this.queue.length > 0) reasons.push('ingestion-incomplete')
    // Records still queued would be lost with the connection: they are not processed, so not complete.
    this.stdoutPartial = ''
    this.chargePartial(0)
    for (const line of this.queue) {
      const size = Buffer.byteLength(line) + QUEUE_ENTRY_OVERHEAD_BYTES
      this.budget.used -= size
      this.queueBytes -= size
    }
    this.queue = []
    this.resolveOutcome({
      kind: ended ? 'ended' : 'lost',
      eligible: ended && reasons.length === 0,
      reasons,
      exit: this.exitInfo,
      stopCause: this.endFrame?.stopCause ?? this.lastStopCause,
      survivorsKilled: this.endFrame?.survivorsKilled ?? false,
      droppedRecords: this.dropped,
      ackFlushed: this.ackFlushed,
    })
  }
}
