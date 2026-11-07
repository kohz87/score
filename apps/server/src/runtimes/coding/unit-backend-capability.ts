import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pdeathsigSupport } from './pdeathsig-exec.ts'
import { syncReceipt, writeReceipt } from './supervisor.mjs'
import { UnitBackendCore } from './unit-backend-core.ts'
import {
  FALLBACK_NOTE,
  MARKER_PAUSE,
  UNIT_CAPABLE_FILE,
  UNIT_NOTE,
} from './unit-backend-helpers.ts'
import type { BackendStatus } from './unit-backend-types.ts'
import { checkCapabilities, listInstallationUnits } from './units.ts'

export class UnitBackendCapability extends UnitBackendCore {
  // ---- startup and capability ------------------------------------------------------------------------------------

  get status(): BackendStatus {
    return this.current
  }
  /** True when new coding runs should use the unit backend. */
  usable(): boolean {
    this.retryMarker()
    return this.current.kind === 'unit' && this.paused === null && !this.closed
  }
  /** Why admission is paused, or null. */
  block(): string | null {
    const frozen = this.deps.frozen?.() ?? null
    if (frozen !== null) return frozen
    this.retryMarker()
    if (this.paused !== null) return this.paused
    if (this.orphans.length > 0)
      return 'A coding service from an earlier session isn’t accounted for. Score paused coding runs until you review it.'
    if (this.unattributed())
      return 'Score can’t tell which agent an unfinished coding run belonged to. It paused all coding runs until you review it.'
    return this.deps.blocked?.() ?? null
  }

  /** An owned launch that may still be running and that no agent can be named for: it fences every coding agent. */
  private unattributed(): boolean {
    if (this.deps.unresolved) return false
    try {
      return (
        this.deps.db.sqlite
          .prepare(
            "SELECT 1 FROM coding_launches WHERE backend = 'unit' AND agent_id IS NULL AND held > 0 AND phase NOT IN ('ended','settled') LIMIT 1",
          )
          .get() !== undefined
      )
    } catch {
      return true
    }
  }
  get orphaned(): readonly string[] {
    return this.orphans
  }

  /** Starts the socket listener and runs the capability check. Never throws: a failure means the fallback backend. */
  async start(): Promise<BackendStatus> {
    return this.check()
  }

  protected listenerAttempt: Promise<void> | null = null
  /**
   * Binds the supervisor socket if this backend doesn't own a listener yet (S4-006). Shared by startup and "Check
   * again", so a failed first bind is retried; concurrent callers share one attempt. `socketError` is cleared only after
   * a confirmed bind. The installation lock is held by the caller for the process lifetime, and a foreign listener is
   * still refused by `CodingSocketServer.start`.
   */
  protected ensureListener(): Promise<void> {
    if (this.deps.disabled !== undefined || this.closed || this.socket.listening)
      return Promise.resolve()
    this.listenerAttempt ??= (async () => {
      try {
        // Held by the caller: the home lock keeps a second Score off this installation's socket (design §4).
        await this.socket.start(true)
        this.socketError = null
      } catch (error) {
        this.socketError = error instanceof Error ? error.message : String(error)
      } finally {
        this.listenerAttempt = null
      }
    })()
    return this.listenerAttempt
  }

  /** "Check again": the same check, on demand (it also retries a listener that failed to bind). */
  async check(): Promise<BackendStatus> {
    await this.ensureListener()
    await this.rescanOrphans()
    if (this.deps.disabled !== undefined) {
      const checks = [{ name: 'manager', ok: false, detail: this.deps.disabled }]
      this.current = this.shortfall(checks, this.deps.disabled)
      return this.current
    }
    const checks: { name: string; ok: boolean; detail: string }[] = []
    let ok: boolean
    try {
      const result = await checkCapabilities({
        run: this.run,
        socketPath: this.socket.path,
        probeProperties: this.deps.probeProperties ?? true,
        graceMs: this.deps.graceMs ?? 5000,
      })
      checks.push(...result.checks)
      ok = result.ok
    } catch (error) {
      checks.push({
        name: 'manager',
        ok: false,
        detail: `the check failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      ok = false
    }
    const listening = this.socketError === null
    checks.push({
      name: 'socket',
      ok: listening,
      detail: listening
        ? 'Score is listening for supervisors'
        : `couldn’t listen: ${this.socketError}`,
    })
    const python = this.deps.python === undefined ? pdeathsigSupport().python : this.deps.python
    checks.push({
      name: 'python',
      ok: python !== null,
      detail: python !== null ? `Python at ${python}` : 'Python 3 is needed to start a coding CLI',
    })
    const notify = this.notifySocket()
    const notifyBin =
      this.deps.notifyBin === undefined ? '/usr/bin/systemd-notify' : this.deps.notifyBin
    // The watchdog needs both: the manager's notify socket and the tool that pings it.
    const notifyOk =
      (this.deps.notifySocket !== undefined || existsSync(notify)) &&
      (notifyBin === null || existsSync(notifyBin))
    checks.push({
      name: 'notify',
      ok: notifyOk,
      detail: notifyOk
        ? 'the manager’s notify socket and systemd-notify exist'
        : `no notify socket at ${notify}, or no ${notifyBin}`,
    })
    const all = ok && listening && python !== null && notifyOk
    if (all) {
      this.paused = null
      this.capable = true
      this.markerPending = !this.persistCapable()
      this.current = {
        kind: 'unit',
        checks,
        checkedAt: new Date(this.clock()).toISOString(),
        note: UNIT_NOTE,
      }
      if (this.markerPending) this.pauseForMarker()
    } else this.current = this.shortfall(checks, checks.find((c) => !c.ok)?.detail ?? '')
    return this.current
  }

  /**
   * The check isn't met. An installation that passed it before is paused (decision 69): no fallback behind its back, the
   * card says why and offers Check again. One that never passed (or was told to use the fallback) runs without a
   * supervisor, with the weaker guarantee stated.
   */
  protected shortfall(checks: BackendStatus['checks'], detail: string): BackendStatus {
    const checkedAt = new Date(this.clock()).toISOString()
    if (this.capable && this.deps.forced !== true) {
      this.paused = `Coding runs are paused: this computer no longer meets what supervised services need${detail ? ` (${detail})` : ''}. Fix that and choose Check again.`
      return { kind: 'unit', checks, checkedAt, note: this.paused }
    }
    this.paused = null
    return {
      kind: 'process-group',
      checks,
      checkedAt,
      note: `${FALLBACK_NOTE} ${detail}`.trim(),
    }
  }

  /** Whether the marker file exists durably afterwards. Never throws. */
  protected persistCapable(): boolean {
    if (this.deps.unresolved || this.deps.disabled !== undefined) return true
    try {
      writeReceipt(
        this.deps.namespaceDir,
        UNIT_CAPABLE_FILE,
        { installation: this.deps.installationId, at: this.clock() },
        this.deps.markerIo,
      )
      return true
    } catch (error) {
      // A marker that exists is not yet one that survives a crash: its writer's directory sync may have failed (the name
      // is there, the sync threw). It counts only once it reads as ours and its contents and directory sync again.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.syncExistingMarker()
      this.deps.onError?.(error)
      return false
    }
  }

  protected syncExistingMarker(): boolean {
    try {
      const body: unknown = JSON.parse(
        readFileSync(join(this.deps.namespaceDir, UNIT_CAPABLE_FILE), 'utf8'),
      )
      if (
        typeof body !== 'object' ||
        body === null ||
        (body as { installation?: unknown }).installation !== this.deps.installationId
      )
        throw new Error('the capability marker isn’t this installation’s')
      syncReceipt(this.deps.namespaceDir, UNIT_CAPABLE_FILE, this.deps.markerIo)
      return true
    } catch (error) {
      this.deps.onError?.(error)
      return false
    }
  }

  protected pauseForMarker(): void {
    this.paused = MARKER_PAUSE
    this.current = { ...this.current, kind: 'unit', note: this.paused }
  }

  /** Retries the marker while it is pending; once durable the pause lifts (the check itself had passed). */
  protected retryMarker(): void {
    if (!this.markerPending || this.closed) return
    if (!this.persistCapable()) return
    this.markerPending = false
    if (this.paused === MARKER_PAUSE) {
      this.paused = null
      this.current = { ...this.current, note: UNIT_NOTE }
    }
  }

  /** An orphan the person has dealt with (the unit is gone) no longer pauses admission. A failed read changes nothing. */
  protected async rescanOrphans(): Promise<void> {
    if (this.orphans.length === 0) return
    const inventory = await listInstallationUnits(this.run, this.prefix)
    if (inventory.kind === 'ok')
      this.orphans = this.orphans.filter((n) => inventory.names.includes(n))
  }

  protected notifySocket(): string {
    return this.deps.notifySocket ?? join(this.deps.runtimeDir, 'systemd', 'notify')
  }

  protected closing: Promise<void> | null = null
  /**
   * Stops new binds, waits out a bind that is already in flight (the socket server refuses to publish a listener that
   * finished after shutdown began), then shuts the listener down. Repeated calls await the same cleanup (S5-006).
   */
  close(): Promise<void> {
    this.closed = true
    this.closing ??= (async () => {
      await this.socket.shutdown()
      await this.listenerAttempt?.catch(() => undefined)
    })()
    return this.closing
  }
}
