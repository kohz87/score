export const PROTOCOL_VERSION: number
export const MAX_FRAME_BYTES: number
export const MAX_CHUNK_BYTES: number
export const EXIT: { ok: 0; failed: 1; socketLoss: 2; rejected: 3; badSpec: 4 }

export interface SupervisorSpec {
  launch: string
  generation: number
  token: string
  /** Absolute path of Score's Unix socket. */
  socket: string
  /** Existing directory the `released` and `ended` receipts are written to. */
  receiptDir: string
  command: {
    file: string
    args: string[]
    env: Record<string, string>
    cwd: string
    stdin?: string | null
  }
  /** One escalation grace (ms). */
  graceMs: number
  /** Wall-clock deadline of the turn (epoch ms). */
  deadline: number
  /** Interpreter and wrapper (pdeathsig-exec.py); both set => the CLI starts through the wrapper into the payload cgroup. */
  python?: string
  wrapper?: string
  notifyBin?: string | null
  watchdogMs?: number
  tickMs?: number
  pollMs?: number
  limits?: { highWaterBytes?: number; maxStreamBytes?: number; maxRunBytes?: number }
}

export interface SupervisorCgroup {
  path: string
  prepare(): string
  payloadState(): 'empty' | 'populated' | 'unknown'
  unitAlone(): boolean
  killPayload(): boolean
}

export interface SupervisorDeps {
  cgroup?: SupervisorCgroup
  connect?: (path: string) => import('node:net').Socket
  now?: () => number
  watchdog?: () => void
  pollMs?: number
}

export function hashSpec(spec: SupervisorSpec): string
export function procStart(pid: number): string | null
export function writeReceipt(dir: string, name: string, body: unknown): void
export function systemdCgroup(root?: string): SupervisorCgroup & {
  unitDir: string
  payloadDir: string
}
export function runSupervisor(spec: SupervisorSpec, deps?: SupervisorDeps): Promise<number>
