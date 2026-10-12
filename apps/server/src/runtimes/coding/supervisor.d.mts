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
  /** Socket-loss cleanup budget (ms); default 2 x graceMs + 5000. */
  disconnectBudgetMs?: number
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
  /** The identity reported in `ready` (tests that run the supervisor in their own process). */
  self?: { pid: number; start: string | null }
  /** Registers the handler for systemd's stop signal; returns the detach function. Default: process SIGINT/SIGTERM. */
  onUnitStop?: (handler: () => void) => (() => void) | void
}

export function hashSpec(spec: SupervisorSpec): string
export function procStart(pid: number): string | null
export function writeReceipt(
  dir: string,
  name: string,
  body: unknown,
  io?: {
    writeSync?: (fd: number, data: Buffer, offset: number, length: number) => number
    linkSync?: (existing: string, target: string) => void
  },
): void
export type ParsedReceipt =
  { state: 'present'; body: Record<string, unknown> } | { state: 'invalid' }
export function parseReceipt(
  text: string,
  kind: 'released' | 'ended',
  expect?: { launch?: string; generation?: number },
): ParsedReceipt
export function systemdCgroup(root?: string): SupervisorCgroup & {
  unitDir: string
  payloadDir: string
}
export function runSupervisor(spec: SupervisorSpec, deps?: SupervisorDeps): Promise<number>
