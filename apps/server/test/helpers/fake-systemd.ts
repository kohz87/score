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
}

export class FakeSystemd {
  readonly units = new Map<string, FakeUnit>()
  readonly calls: string[][] = []
  readonly hooks: FakeHooks = {}
  readonly dirs: string[] = []
  managerPid = 4242
  boot = 'boot-a'
  readonly run: RunTool = (file, args) => this.handle(file, args)

  private result(stdout = '', code = 0, stderr = ''): Promise<ToolResult> {
    return Promise.resolve({ code, stdout, stderr })
  }

  private async handle(file: string, args: string[]): Promise<ToolResult> {
    this.calls.push([file, ...args])
    if (file.endsWith('systemd-run')) return this.systemdRun(args)
    if (file.endsWith('loginctl')) return this.result(this.hooks.lingerOff ? 'Linger=no\n' : 'Linger=yes\n')
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
      if (unit && unit.active !== 'active') this.units.delete(name)
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
    if (!unit) return this.result('LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n')
    return this.result(
      [
        'LoadState=loaded',
        `ActiveState=${unit.active}`,
        `SubState=${unit.active === 'active' ? 'running' : 'dead'}`,
        `MainPID=${unit.active === 'active' ? (this.hooks.mainPid ?? process.pid) : 0}`,
        `InvocationID=${unit.invocationId}`,
        `ControlGroup=${unit.controlGroup}`,
        `Result=${unit.active === 'failed' ? 'exit-code' : 'success'}`,
        'Job=',
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
    }
    unit.done = runSupervisor(spec, {
      cgroup,
      watchdog: () => undefined,
      pollMs: 20,
      onUnitStop: (handler) => {
        unit.stopHandler = handler
        return () => {
          unit.stopHandler = null
        }
      },
    }).then((code) => {
      unit.exitCode = code
      unit.active = code === 0 ? 'inactive' : 'failed'
      // A cleanly exited transient unit is garbage-collected; a failed one stays until reset-failed.
      if (code === 0) this.units.delete(name)
      return code
    })
    this.units.set(name, unit)
    this.hooks.afterStart?.(unit)
    return this.result()
  }

  /** The unit's cgroup as the backend reads it: populated while the unit is active, empty after, absent once collected. */
  population = (controlGroup: string): 'populated' | 'empty' | 'absent' => {
    const unit = [...this.units.values()].find((u) => u.controlGroup === controlGroup)
    if (!unit) return 'absent'
    return unit.active === 'active' ? 'populated' : 'empty'
  }

  /** A unit that exists without a supervisor in this process (recovery tests): stopping it ends it, unless ignored. */
  addUnit(name: string, over: Partial<FakeUnit> = {}): FakeUnit {
    let finish: (code: number) => void = () => undefined
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
      ...over,
    }
    void unit.done.then(() => {
      unit.active = 'inactive'
      this.units.delete(name)
    })
    this.units.set(name, unit)
    return unit
  }

  /** Detaches a unit's supervisor from the table as a cold manager restart would (the process is not stopped here). */
  forget(name: string): void {
    this.units.delete(name)
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
