import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CodingSocketServer,
  type RunHandlers,
  type RunSession,
  type SessionOutcome,
  type SocketLimits,
} from '../../src/runtimes/coding/coding-socket.ts'
import {
  hashSpec,
  runSupervisor,
  type SupervisorCgroup,
  type SupervisorSpec,
} from '../../src/runtimes/coding/supervisor.mjs'

export const WRAPPER = fileURLToPath(
  new URL('../../src/runtimes/coding/pdeathsig-exec.py', import.meta.url),
)
export const SUPERVISOR = fileURLToPath(
  new URL('../../src/runtimes/coding/supervisor.mjs', import.meta.url),
)

export const alive = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}

/** A cgroup stand-in without systemd: "populated" while the wrapped CLI or any listed survivor still lives. */
export function fakeCgroup(
  dir: string,
): SupervisorCgroup & { payloadDir: string; survivorsFile: string } {
  const payloadDir = join(dir, 'payload')
  const survivorsFile = join(dir, 'survivors')
  const pids = (): number[] => {
    const out: number[] = []
    for (const f of [join(payloadDir, 'cgroup.procs'), survivorsFile]) {
      try {
        for (const w of readFileSync(f, 'utf8').split(/\s+/))
          if (/^\d+$/.test(w)) out.push(Number(w))
      } catch {
        // none yet
      }
    }
    return out
  }
  return {
    path: '/fake/unit.service',
    payloadDir,
    survivorsFile,
    prepare() {
      mkdirSync(payloadDir)
      writeFileSync(join(payloadDir, 'cgroup.procs'), '')
      return payloadDir
    },
    payloadState: () => (pids().some(alive) ? 'populated' : 'empty'),
    unitAlone: () => true,
    killPayload() {
      // Only pids this test's own CLIs recorded in its survivors file.
      for (const pid of pids())
        if (alive(pid))
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // gone
          }
      return true
    },
  }
}

export interface Harness {
  dir: string
  server: CodingSocketServer
  session: RunSession
  spec: SupervisorSpec
  cgroup: ReturnType<typeof fakeCgroup>
  receiptDir: string
  done: Promise<number>
  outcome: Promise<SessionOutcome>
  stdout: string[]
  stderr: string[]
}

export interface HarnessOptions {
  script: string
  graceMs?: number
  deadline?: number
  stdin?: string
  limits?: Partial<SocketLimits>
  specLimits?: SupervisorSpec['limits']
  handlers?: Partial<RunHandlers>
  watchdog?: () => void
  watchdogMs?: number
  tickMs?: number
  launch?: string
  preReceipt?: string
  token?: string
  /** Test seam: the supervisor's socket (wrap it to model a stuck consumer). */
  connect?: (path: string) => net.Socket
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'score-sup-'))
  const server = new CodingSocketServer({
    runtimeDir: dir,
    installationId: 'abcdef0123456789',
    limits: options.limits,
  })
  await server.start(true)
  const receiptDir = join(dir, 'receipts')
  mkdirSync(receiptDir)
  if (options.preReceipt) writeFileSync(join(receiptDir, options.preReceipt), '{}')
  const cgroupDir = join(dir, 'cg')
  mkdirSync(cgroupDir)
  const cgroup = fakeCgroup(cgroupDir)
  const launch = options.launch ?? 'launch1'
  const spec: SupervisorSpec = {
    launch,
    generation: 1,
    token: '',
    socket: server.path,
    receiptDir,
    command: {
      file: process.execPath,
      args: ['-e', options.script],
      env: { PATH: process.env['PATH'] ?? '', SURVIVORS: cgroup.survivorsFile },
      cwd: dir,
      stdin: options.stdin ?? null,
    },
    graceMs: options.graceMs ?? 500,
    deadline: options.deadline ?? Date.now() + 60_000,
    python: '/usr/bin/python3',
    wrapper: WRAPPER,
    notifyBin: null,
    tickMs: options.tickMs ?? 50,
    watchdogMs: options.watchdogMs ?? 100,
    pollMs: 20,
    limits: options.specLimits,
  }
  const stdout: string[] = []
  const stderr: string[] = []
  const { token, session } = server.expect({
    launch,
    generation: 1,
    specHash: hashSpec(spec),
    handlers: {
      ...options.handlers,
      onStdoutRecord: options.handlers?.onStdoutRecord ?? ((line) => void stdout.push(line)),
      onStderr: options.handlers?.onStderr ?? ((text) => void stderr.push(text)),
    },
  })
  spec.token = options.token ?? token
  const done = runSupervisor(spec, {
    cgroup,
    watchdog: options.watchdog ?? (() => undefined),
    pollMs: 20,
    ...(options.connect ? { connect: options.connect } : {}),
  })
  return {
    dir,
    server,
    session,
    spec,
    cgroup,
    receiptDir,
    done,
    outcome: session.outcome,
    stdout,
    stderr,
  }
}

export const receipts = (h: Harness): string[] =>
  existsSync(h.receiptDir) ? readdirSync(h.receiptDir).sort() : []
