import type { CodingPermission, CodingRuntime } from '@score/contract'

/**
 * What a driver makes of one CLI stream line. Drivers are the only code that knows a CLI's flags and event shapes
 * (same rule as D2.1 for Hermes); everything past this type is runtime-neutral.
 */
export type CodingEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_start'
      /** The CLI's own call id; pairs a start with its end. */
      callId: string
      tool: string
      /** A short, human-readable summary of the arguments (redacted by the translator). */
      preview: string
      /** What a Watch frame can be built from. */
      detail?: ToolDetail
    }
  | { kind: 'tool_end'; callId: string; ok: boolean; preview: string; exitCode?: number | null }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: 'result'; ok: boolean; text?: string; error?: string }

export type ToolDetail =
  | { type: 'command'; command: string; cwd?: string }
  | { type: 'write'; path: string; content: string }
  | { type: 'replace'; path: string; oldString: string; newString: string }
  | { type: 'file'; path: string; change: 'add' | 'update' | 'delete' }
  /** Browser or web tools (Antigravity): a generic browser frame, with the URL when the call named one. */
  | { type: 'browser'; url: string | null }

export interface UsageReading {
  groups: {
    name: string
    fiveHourRemainingPercent: number | null
    fiveHourResets: string | null
    weeklyRemainingPercent: number | null
    weeklyResets: string | null
  }[]
  text: string
}

export interface LineParser {
  /** One non-empty stdout line. Unknown or malformed lines yield nothing and are counted. */
  parse(line: string): CodingEvent[]
  readonly stats: { unknown: number; malformed: number }
}

export interface DriverRunOptions {
  workspace: string
  /** The turn's prompt. Drivers with `promptVia: 'argv'` put it in the argument vector; the rest ignore it (stdin). */
  prompt: string
  permission: CodingPermission
  model: string | null
  /** The CLI's own session id from an earlier turn, to resume. */
  sessionId: string | null
  /** Extra settings file the driver wants (Claude Code deny rules), written by the caller before the spawn. */
  settingsPath: string | null
  /** Absolute folders the CLI must never read or write (Score's, the agent runtime's, SSH). */
  denyPaths: readonly string[]
  /** Absolute file patterns off limits too (the CLIs' own login files). */
  denyFiles: readonly string[]
}

export interface CodingDriver {
  readonly runtime: CodingRuntime
  readonly label: string
  readonly executable: string
  /** Exact versions Score was tested with. */
  readonly testedVersions: readonly string[]
  /** Whether Score can run this CLI at all. */
  readonly supported: boolean
  readonly quota: string
  /** Where the prompt goes. stdin is the rule; Antigravity's `-p` takes it as an argument (contract §8). */
  readonly promptVia: 'stdin' | 'argv'
  /** Permission levels live-verified for this CLI. Others are shown disabled and refused (PLAN 7.6). */
  readonly verifiedPermissions: readonly CodingPermission[]
  /** Extra warning where the CLI is chosen (what it can do beyond editing files). */
  readonly warning: string | null
  /** Creating an agent needs the "it can read every file you can" acknowledgement. */
  /** True when the agent can read files outside its workspace at this level, so adding it needs the person's
   *  acknowledgement (Codex always; Antigravity only at full access, where its sandbox is off). */
  readonly requiresReadAck: (permission: CodingPermission) => boolean
  /** Whether the CLI can print its own quota, and how (never a model turn). */
  readonly usage?: { args: readonly string[]; parse(output: string): UsageReading }
  /** `--version` output to a bare version string, or null when it doesn't look like this CLI. */
  parseVersion(output: string): string | null
  /** Argument vector after the executable. The prompt is never in it: it goes to stdin. */
  buildArgs(options: DriverRunOptions): string[]
  createParser(options: { cwd: string }): LineParser
  /** File names under `<score home>/coding/<agent>/` this driver wants written before a run. */
  settingsFile?(
    denyPaths: readonly string[],
    denyFiles: readonly string[],
  ): { name: string; content: string }
}

export const CODING_LIMITS = {
  /** Wall time of one turn. */
  maxTurnMs: 30 * 60_000,
  /** SIGINT, then SIGTERM after this long, then SIGKILL after this long again. */
  stopGraceMs: 5_000,
  /** One stdout line larger than this is dropped (and counted). */
  maxLineBytes: 1024 * 1024,
  /** All stdout of a turn. Past it the process is stopped. */
  maxOutputBytes: 32 * 1024 * 1024,
  /** Kept tail of stderr, for the failure notice. */
  stderrBytes: 8 * 1024,
} as const
