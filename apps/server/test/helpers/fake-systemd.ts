import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunTool, ToolResult } from '../../src/runtimes/coding/units.ts'
import { runSupervisor, type SupervisorSpec } from '../../src/runtimes/coding/supervisor.mjs'
import { fakeCgroup } from './coding-harness.ts'

// A stand-in for systemd's user manager for tests that drive the real CodingRuntime and UnitBackend without systemd:
// `systemd-run` runs the real supervisor in this process (its cgroup boundary faked), and `systemctl` answers from a
// table of units. Nothing here touches the host's units.

export interface FakeUnit {
  name: string
  invocationId: string
  active: 'active' | 'inactive' | 'failed'
  controlGroup: string
  dir: string
  stopHandler: (() => void) | null
  survivors: string
  done: Promise<number>
  exitCode: number | null
  /** The identity of the unit's supervisor, as Score records it (a fake pid and start time: the supervisor runs in the test). */
  pid: number
  start: string
  /** The supervisor (the unit's main process) is still running. */
  running: boolean
  /** The unit's cgroup (payload processes the test recorded count as populating it). */
  cgroup: { payloadState(): 'empty' | 'populated' | 'unknown' } | null
  /** Keeps the cgroup populated whatever the unit says (a survivor outside the supervisor's reach). */
  forcePopulated?: boolean
}

interface CgroupEntry {
  unit: FakeUnit
  /** The unit was collected: its cgroup directory is gone. */
  removed: boolean
}

export interface FakeHooks {
  /** `systemd-run` answers with this failure instead of starting anything. */
  startFails?: string
  /** `systemctl show <unit>` fails like a transport error. */
  showFails?: boolean
  /** Reported MainPID (default: this process, where the supervisor runs). */
  mainPid?: number
  /** Called after the unit started, before `ready` can be verified. */
  afterStart?: (unit: FakeUnit) => void
  /** Do not honour `systemctl stop` (the unit keeps running). */
  ignoreStop?: boolean
  /** `loginctl` reports linger off. */
  lingerOff?: boolean
  /** A cleanly exited unit stays visible (inactive) instead of being collected at once, so ExecMain* can be read. */
  keepExited?: boolean
  /** What `systemctl show` reports as ExecMainStatus / ExecMainPID instead of the supervisor's own. */
  execMainStatus?: number
  execMainPid?: number
}

export class FakeSystemd {
  readonly units = new Map<string, FakeUnit>()
  readonly calls: string[][] = []
  readonly hooks: FakeHooks = {}
  readonly dirs: string[] = []
  /** Every signal sent to a supervisor through the pidfd seam. */
  readonly signals: { pid: number; start: string; signal: string; delivered: boolean }[] = []
  private readonly cgroups = new Map<string, CgroupEntry>()
  private nextPid = 900_000
  managerPid = 4242
  boot = 'boot-a'
  readonly run: RunTool = (file, args) => this.handle(file, args)

  private result(stdout = '', code = 0, stderr = ''): Promise<ToolResult> {
    return Promise.resolve({ code, stdout, stderr })
  }

  private async handle(file: string, args: string[]): Promise<ToolResult> {
    this.calls.push([file, ...args])
    if (file.endsWith('systemd-run')) return this.systemdRun(args)
    if (file.endsWith('loginctl'))
      return this.result(this.hooks.lingerOff ? 'Linger=no\n' : 'Linger=yes\n')
    if (!file.endsWith('systemctl')) return this.result('', 127, 'unknown tool')
    const user = args[0] === '--user'
    const rest = user ? args.slice(1) : args
    const verb = rest[0]
    if (verb === 'show') return this.show(user, rest.slice(1))
    if (verb === 'show-environment') return this.result('PATH=/usr/bin\nLANG=C.UTF-8\n')
    const name = rest[rest.indexOf('--') + 1] ?? ''
    if (verb === 'stop') return this.stop(name)
    if (verb === 'reset-failed') {
      const unit = this.units.get(name)
      if (unit && unit.active !== 'active') this.removeUnit(name)
      return this.result()
    }
    if (verb === 'list-units') {
      const pattern = rest.at(-1) ?? ''
      const prefix = pattern.replace(/\*$/, '')
      const lines = [...this.units.values()]
        .filter((unit) => unit.name.startsWith(prefix))
        .map((unit) => `${unit.name} loaded ${unit.active} running Score coding run`)
      return this.result(lines.join('\n') + (lines.length ? '\n' : ''))
    }
    return this.result('', 1, `unsupported verb ${verb}`)
  }

  private show(user: boolean, args: string[]): Promise<ToolResult> {
    const name = args[args.indexOf('--') + 1] ?? ''
    if (!user) return this.result(`MainPID=${this.managerPid}\n`)
    if (this.hooks.showFails) return this.result('', 1, 'Failed to connect to bus')
    if (name === '' || !name.endsWith('.service')) return this.result('Version=259\n')
    const unit = this.units.get(name)
    if (!unit)
      return this.result('LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n')
    return this.result(
      [
        'LoadState=loaded',
        `ActiveState=${unit.active}`,
        `SubState=${unit.active === 'active' ? 'running' : 'dead'}`,
        `MainPID=${unit.active === 'active' ? (this.hooks.mainPid ?? unit.pid) : 0}`,
        `InvocationID=${unit.invocationId}`,
        `ControlGroup=${unit.controlGroup}`,
        `Result=${unit.active === 'failed' || (this.hooks.execMainStatus ?? 0) !== 0 ? 'exit-code' : 'success'}`,
        'Job=',
        // The main process as systemd last ran it (kept after it exited): CLD_EXITED = 1.
        `ExecMainPID=${this.hooks.execMainPid ?? unit.pid}`,
        `ExecMainStatus=${this.hooks.execMainStatus ?? unit.exitCode ?? 0}`,
        `ExecMainCode=${unit.running ? 0 : 1}`,
      ].join('\n') + '\n',
    )
  }

  private async stop(name: string): Promise<ToolResult> {
    const unit = this.units.get(name)
    if (!unit) return this.result()
    if (this.hooks.ignoreStop) return this.result()
    unit.stopHandler?.()
    await Promise.race([unit.done, new Promise((resolve) => setTimeout(resolve, 8000))])
    return this.result()
  }

  private systemdRun(args: string[]): Promise<ToolResult> {
    if (args.includes('--wait')) return this.result() // the capability probe
    if (this.hooks.startFails) return this.result('', 1, this.hooks.startFails)
    const name = (args.find((a) => a.startsWith('--unit=')) ?? '').slice(7)
    const specPath = args.at(-1)!
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SupervisorSpec
    // Like the real supervisor: the spec is deleted as soon as it is read.
    unlinkSync(specPath)
    const dir = mkdtempSync(join(tmpdir(), 'score-fakesd-'))
    this.dirs.push(dir)
    mkdirSync(join(dir, 'cg'))
    const cgroup = { ...fakeCgroup(join(dir, 'cg')), path: `/fake/${name}` }
    const pid = this.nextPid++
    const unit: FakeUnit = {
      name,
      invocationId: randomBytes(16).toString('hex'),
      active: 'active',
      controlGroup: `/fake/${name}`,
      dir,
      stopHandler: null,
      survivors: cgroup.survivorsFile,
      exitCode: null,
      done: Promise.resolve(0),
      pid,
      start: String(100_000 + pid),
      running: true,
      cgroup,
    }
    this.cgroups.set(unit.controlGroup, { unit, removed: false })
    unit.done = runSupervisor(spec, {
      cgroup,
      watchdog: () => undefined,
      pollMs: 20,
      self: { pid, start: unit.start },
      onUnitStop: (handler) => {
        unit.stopHandler = handler
        return () => {
          unit.stopHandler = null
        }
      },
    }).then((code) => {
      unit.exitCode = code
      unit.running = false
      unit.active = code === 0 ? 'inactive' : 'failed'
      // A cleanly exited transient unit is garbage-collected; a failed one stays until reset-failed.
      if (code === 0 && !this.hooks.keepExited) this.removeUnit(name)
      return code
    })
    this.units.set(name, unit)
    this.hooks.afterStart?.(unit)
    return this.result()
  }

  /**
   * The cgroup as the backend reads it, derived from the cgroup itself and not from the unit's state: populated while the
   * supervisor runs or any payload process (or recorded survivor) lives; empty once none does; absent once the unit was
   * collected (the directory is gone). A unit can be `inactive` in systemd's eyes with a populated cgroup.
   */
  population = (controlGroup: string): 'populated' | 'empty' | 'absent' => {
    const entry = this.cgroups.get(controlGroup)
    if (!entry || entry.removed) return 'absent'
    const { unit } = entry
    if (unit.forcePopulated || unit.running) return 'populated'
    return unit.cgroup?.payloadState() === 'populated' ? 'populated' : 'empty'
  }

  private removeUnit(name: string): void {
    const unit = this.units.get(name)
    this.units.delete(name)
    if (!unit) return
    const entry = this.cgroups.get(unit.controlGroup)
    // Collecting a unit removes its cgroup directory, but only once nothing lives in it.
    if (
      entry &&
      !unit.running &&
      !unit.forcePopulated &&
      unit.cgroup?.payloadState() !== 'populated'
    )
      entry.removed = true
  }

  /** The start time of a fake supervisor pid; undefined for any other pid (the caller then reads /proc). */
  procStart = (pid: number): string | null | undefined => {
    for (const { unit } of this.cgroups.values()) if (unit.pid === pid) return unit.start
    return undefined
  }

  /**
   * Stands in for the pidfd signal: delivers SIGINT-style stop to the supervisor with exactly this pid and start time,
   * `mismatch` for any other (gone, or a different process holding the pid). It never touches a unit by name.
   */
  signal = (pid: number, start: string, signal: NodeJS.Signals): 'signalled' | 'mismatch' => {
    const target = [...this.cgroups.values()].find(
      ({ unit }) => unit.pid === pid && unit.start === start && unit.running,
    )?.unit
    this.signals.push({ pid, start, signal, delivered: target !== undefined })
    if (!target) return 'mismatch'
    if (!this.hooks.ignoreStop) target.stopHandler?.()
    return 'signalled'
  }

  /** A unit that exists without a supervisor in this process (recovery tests): stopping it ends it, unless ignored. */
  addUnit(name: string, over: Partial<FakeUnit> = {}): FakeUnit {
    let finish: (code: number) => void = () => undefined
    const pid = this.nextPid++
    const unit: FakeUnit = {
      name,
      invocationId: randomBytes(16).toString('hex'),
      active: 'active',
      controlGroup: `/fake/${name}`,
      dir: '',
      stopHandler: () => finish(0),
      survivors: '',
      exitCode: null,
      done: new Promise<number>((resolve) => {
        finish = resolve
      }),
      pid,
      start: String(100_000 + pid),
      running: true,
      cgroup: null,
      ...over,
    }
    void unit.done.then(() => {
      unit.active = 'inactive'
      unit.running = false
      this.removeUnit(name)
    })
    this.units.set(name, unit)
    this.cgroups.set(unit.controlGroup, { unit, removed: false })
    return unit
  }

  /** Detaches a unit's supervisor from the table as a cold manager restart would (the process is not stopped here). */
  forget(name: string): void {
    this.units.delete(name)
  }

  /** The unit and its cgroup vanish as a manager's removal would (the directory is gone). */
  collect(name: string): void {
    const unit = this.units.get(name)
    this.units.delete(name)
    const entry = unit ? this.cgroups.get(unit.controlGroup) : undefined
    if (entry) entry.removed = true
  }

  async cleanup(): Promise<void> {
    for (const unit of this.units.values()) {
      unit.stopHandler?.()
    }
    await Promise.race([
      Promise.allSettled([...this.units.values()].map((u) => u.done)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true })
  }
}
