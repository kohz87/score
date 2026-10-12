import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  AgentDetail,
  CodingAgent,
  CodingUsage,
  CodingRuntime as RuntimeId,
} from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import { attachRunMessage, isCancelledTurn } from '../../domain/message-runs.ts'
import { HttpError } from '../../errors.ts'
import { runDraft, type StopOutcome } from '../../hermes/index.ts'
import type { Ingest } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { checkRoot, type RootPolicy } from '../../workspace/policy.ts'
import { CliLocator } from './cli.ts'
import { driverFor } from './drivers.ts'
import {
  bootId,
  killRecordedGroup,
  processStart,
  type GroupOutcome,
  type MemberIdentity,
} from './proc.ts'
import { spawnCli, SpawnRecordError, type CliRun, type StopReason } from './process.ts'
import {
  cliSessionFor,
  forgetCliSession,
  getCodingAgent,
  listCodingAgents,
  type StoredCodingAgent,
} from './store.ts'
import {
  eventObservation,
  newTranslation,
  runningObservation,
  terminalObservation,
  type RunTranslation,
  type TerminalInfo,
} from './translate.ts'
import type { CodingEvent } from './types.ts'
import type { BackendStatus, UnitBackend } from './unit-backend.ts'

export interface CodingRuntimeDeps {
  db: ScoreDb
  ingest: Pick<Ingest, 'submit'>
  locator: CliLocator
  /** Score's home: per-agent settings files live under `<home>/coding/<agent>/`. */
  home: string
  /** The same folder rules as the Workspace tab (6.1). */
  policy: RootPolicy
  onError?: (error: unknown) => void
  maxTurnMs?: number
  graceMs?: number
  /** First wait before a failed terminal result is saved again (doubles each time). */
  terminalRetryMs?: number
  /** Test seam: the process launcher. */
  spawn?: typeof spawnCli
  /** Test seam: how a recorded group is stopped and proven gone. */
  killGroup?: typeof killRecordedGroup
  /** First wait before an unresolved group is stopped again in the background (doubles to a minute). */
  reapRetryMs?: number
  /** How long Stop waits to see a recorded group end before it answers `unconfirmed` (the kill goes on). */
  stopObserveMs?: number
  /**
   * The supervised-unit backend (7.7a). Present only where Score owns an installation journal; a run uses it while its
   * capability check passes, and the process-group backend otherwise.
   */
  unit?: UnitBackend
  /** Units carrying this installation's prefix that no journal launch owns: the caller fences and raises a review item. */
  onOrphans?: (units: string[]) => void
}

/** What both launch backends hand back to `execute()`. */
interface Attempt {
  exitCode: number | null
  signal: string | null
  stopped: StopReason | null
  stderr: string
  spawnError: string | null
  leftovers: boolean
  /** Every process of the run is proven gone (a group for the fallback, the unit's cgroup for the unit backend). */
  groupGone: boolean
  /** Every stdout record was parsed and saved (completeness, design §4). */
  complete: boolean
  /** Set when the run never started (refused, revoked, stopped first). */
  refusal: string | null
  reasons: string[]
  launchId: string | null
}

interface ActiveRun {
  agentId: string
  runId: string
  turnId: string
  /** Set once the process (or unit) exists. */
  process?: { stop(reason?: StopReason): void }
  /** Stop asked while the turn was still waiting for the agent's previous turn. */
  stopBeforeStart?: StopReason
  /** A process was started for this run: Stop must then wait for proof that its group ended. */
  launched?: boolean
  /** Some group of this run was not proven gone. */
  unproven?: boolean
  /** Settles when the run has ended: true when every group it started is proven gone. */
  ended: Promise<boolean>
  settle(): void
}

const IntentRow = z.object({
  id: z.string(),
  state: z.enum(['pending', 'sent', 'accepted', 'failed', 'unknown']),
  result: z.string().nullable(),
  payload: z.string(),
})
const IntentPayload = z.object({
  agentId: z.string(),
  input: z.string(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
})
const ProcessRow = z.object({
  run_id: z.string(),
  pid: z.int(),
  pgid: z.int(),
  start_time: z.string().nullable(),
  boot_id: z.string().nullable(),
  unresolved: z.int(),
  unobservable: z.int(),
})
const MemberRow = z.object({ pid: z.int(), start_time: z.string() })
const KIND = 'start_coding_run'
const UNRESOLVED_NOTE =
  'Some of its tools may still be running. Score keeps trying to stop them and will let this agent take new messages once they have ended.'

const TERMINAL_NOTE = {
  interrupted:
    'Score restarted while this ran. The conversation is kept, so the next message resumes it.',
} as const

/** The CLI's own "that session doesn't exist" refusal, matched per driver (anchored, so ordinary errors don't count). */
function refusesResume(driver: ReturnType<typeof driverFor>, message: string): boolean {
  return driver.resumeRefusal?.test(message.trim()) ?? false
}

function oneLine(text: string, max: number): string {
  return redactBounded(text.replace(/\s+/g, ' ').trim(), max)
}

export class CodingRuntime {
  private readonly active = new Map<string, ActiveRun>()
  private readonly queues = new Map<string, Promise<void>>()
  /** Terminal results that are being saved in the background after the first attempts failed (S3-004). */
  private readonly deliveries = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: CodingRuntimeDeps) {}

  /** How coding runs are launched right now, with the capability check behind it (docs/API-CONTRACT.md §8). */
  backend(): BackendStatus {
    return (
      this.deps.unit?.status ?? {
        kind: 'process-group',
        checks: [],
        checkedAt: new Date().toISOString(),
        note: 'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them.',
      }
    )
  }
  /** "Check again": reruns the capability check; new runs follow its answer. */
  async checkBackend(): Promise<BackendStatus> {
    return this.deps.unit ? this.deps.unit.check() : this.backend()
  }

  get locator(): CliLocator {
    return this.deps.locator
  }
  get policy(): RootPolicy {
    return this.deps.policy
  }

  isCodingAgent(id: string): boolean {
    return getCodingAgent(this.deps.db.sqlite, id) !== null
  }
  agents(): StoredCodingAgent[] {
    return listCodingAgents(this.deps.db.sqlite)
  }

  /** The agent as the front end sees it, with the CLI's state. */
  async view(agent: StoredCodingAgent): Promise<CodingAgent> {
    const driver = driverFor(agent.runtime)
    const cli = await this.deps.locator.detect(driver)
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      runtime: agent.runtime,
      workspace: agent.workspace,
      permission: agent.permission,
      model: agent.model,
      style: agent.style,
      quota: driver.quota,
      cli: {
        state: cli.state,
        version: cli.version,
        testedVersions: [...driver.testedVersions],
        confirmed: cli.version !== null && agent.confirmedVersion === cli.version,
      },
      heldGroups: this.heldGroups(agent.id),
      createdAt: agent.createdAt,
    }
  }

  /** Coding agents as `AgentDetail`, so Team, Now, Flow and rooms treat them like any agent. */
  async details(): Promise<AgentDetail[]> {
    const rows = this.agents()
    const busy = new Set(
      z
        .array(z.object({ profile: z.string() }))
        .parse(
          this.deps.db.sqlite
            .prepare(
              "SELECT DISTINCT profile FROM runs WHERE runtime != 'hermes' AND status IN ('queued','running')",
            )
            .all(),
        )
        .map((row) => row.profile),
    )
    return Promise.all(
      rows.map(async (agent): Promise<AgentDetail> => {
        const view = await this.view(agent)
        const driver = driverFor(agent.runtime)
        const usable = view.cli.state === 'ready' || view.cli.state === 'untested_version'
        const working = busy.has(agent.id)
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role || `${driver.label} coding agent`,
          style: agent.style,
          status: !usable ? 'offline' : working ? 'working' : 'idle',
          activity: working ? 'Running a turn' : null,
          model: {
            id: agent.model ?? 'default',
            label: agent.model ?? `${driver.label} default`,
            via: driver.label,
            fallback: null,
          },
          served: usable,
          runtime: agent.runtime,
          runtimeNote: `${driver.label} · ${driver.quota}`,
          tagline: agent.role,
          personality: { excerpt: '', source: 'SOUL.md' },
          reportsTo: null,
          worksIn: null,
          rulesFile: null,
          skills: [],
          memory: [],
          tools: [],
          helpersMax: null,
          routines: [],
          channels: [],
          permissions: [
            {
              id: 'sandbox',
              label: `Sandbox: ${agent.permission}`,
              level: agent.permission === 'full' ? 'allowed' : 'asks',
              inherited: false,
            },
          ],
        }
      }),
    )
  }

  private readonly usageCache = new Map<string, { at: number; value: CodingUsage }>()

  /**
   * The CLI's own quota (Antigravity `/usage`): one short process, no model turn, cached for a minute. The tested
   * version is required, like for a turn.
   */
  async usage(runtime: RuntimeId): Promise<CodingUsage> {
    const driver = driverFor(runtime)
    if (!driver.usage)
      throw new HttpError(409, 'unsupported', `${driver.label} has no quota reading.`)
    const cached = this.usageCache.get(runtime)
    if (cached && Date.now() - cached.at < 60_000) return cached.value
    const cli = await this.deps.locator.detect(driver, { fresh: true })
    if (cli.state === 'not_installed' || cli.state === 'not_supported')
      throw new HttpError(422, 'cli_not_installed', cli.message ?? 'The CLI isn’t available.')
    if (cli.state === 'untested_version')
      throw new HttpError(422, 'untested_cli_version', cli.message ?? 'Untested CLI version.')
    const { file, args } = this.deps.locator.command(driver)
    const cwd = join(this.deps.home, 'coding')
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const output = await new Promise<string>((done, fail) =>
      execFile(
        file,
        [...args, ...driver.usage!.args],
        { cwd, env: this.deps.locator.childEnv(), timeout: 20_000, maxBuffer: 256 * 1024 },
        (error, stdout) => (error ? fail(error) : done(stdout)),
      ),
    ).catch(() => {
      throw new HttpError(502, 'usage_unavailable', `${driver.label} didn’t report its quota.`)
    })
    const reading = driver.usage.parse(output)
    if (!reading.text)
      throw new HttpError(502, 'usage_unavailable', `${driver.label} didn’t report its quota.`)
    const value: CodingUsage = {
      runtime,
      fetchedAt: new Date().toISOString(),
      groups: reading.groups,
      text: redactBounded(reading.text, 8000),
    }
    this.usageCache.set(runtime, { at: Date.now(), value })
    return value
  }

  /** The room's Hermes-style session key is `score-<room>-<agent>`: forget that room's CLI session. */
  forgetRoomSession(sessionKey: string, agentId: string): void {
    const suffix = `-${agentId}`
    if (!sessionKey.startsWith('score-') || !sessionKey.endsWith(suffix)) return
    forgetCliSession(this.deps.db.sqlite, sessionKey.slice(6, -suffix.length), agentId)
  }

  /** Why this CLI may not run for this agent right now, or null. Read fresh when `fresh` (before a spawn). */
  private async cliRefusal(
    agent: StoredCodingAgent,
    driver: ReturnType<typeof driverFor>,
    fresh: boolean,
  ): Promise<{ code: string; message: string; notice: string } | null> {
    const cli = await this.deps.locator.detect(driver, { fresh })
    if (cli.state === 'not_supported' || cli.state === 'not_installed')
      return {
        code: 'cli_not_installed',
        message: cli.message ?? 'The CLI isn’t available.',
        notice: `${driver.label} can't run: ${cli.message ?? 'not available'}`,
      }
    if (!this.deps.locator.verifiedPermissions(driver).includes(agent.permission))
      return {
        code: 'permission_unverified',
        message: `${driver.label} is not verified for ${agent.permission} access yet`,
        notice: `${driver.label} is not verified for ${agent.permission} access yet. Open this agent in Team and pick a verified level.`,
      }
    if (cli.state === 'untested_version' && agent.confirmedVersion !== cli.version)
      return {
        code: 'untested_cli_version',
        message: cli.message ?? 'Untested CLI version.',
        notice: `${driver.label} ${cli.version ?? ''} is an untested version. Open this agent in Team and confirm it to run.`,
      }
    return null
  }

  /** The CLIs' own login files: an agent has no business reading them. */
  private denyFiles(): string[] {
    const home = this.deps.policy.home
    return [
      join(home, '.claude', '.credentials*'),
      join(home, '.codex', 'auth*'),
      // Antigravity's sign-in and config live under ~/.gemini (no deny rules in agy itself: its sandbox is the barrier).
      join(home, '.gemini', 'antigravity-cli', '**'),
      join(home, '.gemini', '**'),
    ]
  }

  /** Folders the policy keeps off limits, in lexical and resolved form. */
  private denyPaths(): string[] {
    return this.deps.policy.forbidden.flatMap((folder) => {
      const forms = [resolve(folder)]
      try {
        forms.push(realpathSync(folder))
      } catch {
        // not created yet: only the lexical form exists
      }
      return forms
    })
  }

  private roomOf(turnId: string): string | null {
    const row = this.deps.db.sqlite
      .prepare('SELECT room_id FROM message_runs WHERE turn_id = ?')
      .get(turnId) as { room_id: string } | undefined
    return row?.room_id ?? null
  }

  /**
   * Admits a room turn for a coding agent. Mirrors the Hermes path: a durable intent first, then the run row and the
   * room's streaming reply, then the process. Only after the run is admitted does anything spawn.
   */
  async startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
  }): Promise<{ runId: string }> {
    const { db, ingest } = this.deps
    this.assertOpen()
    const agent = getCodingAgent(db.sqlite, req.agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    assertAgentAdmits(db.sqlite, agent.id)
    if (this.hasUnresolvedGroup(agent.id))
      throw new HttpError(422, 'agent_still_stopping', UNRESOLVED_NOTE, {
        notice: UNRESOLVED_NOTE,
        agentId: agent.id,
      })
    // Supervised units pause on a fence (an unreadable journal, orphan units): the person reviews it first (design §7).
    const paused = this.deps.unit?.usable() ? this.deps.unit.block() : null
    if (paused) throw new HttpError(409, 'coding_paused', paused, { notice: paused })
    const driver = driverFor(agent.runtime)
    const existing = db.sqlite
      .prepare('SELECT * FROM command_intents WHERE idempotency_key = ?')
      .get(req.turnId)
    if (existing !== undefined) {
      const intent = IntentRow.parse(existing)
      if (intent.state === 'accepted' && intent.result) return { runId: intent.result }
    }
    // Refuse before anything is stored: a missing or untested CLI is the person's to fix, not a retry loop.
    const refusal = await this.cliRefusal(agent, driver, false)
    if (refusal) throw new HttpError(422, refusal.code, refusal.message, { notice: refusal.notice })
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok)
      throw new HttpError(422, 'workspace_unavailable', checked.reason, {
        notice: `The workspace is unavailable: ${checked.reason}`,
      })

    // 1. Durable intent (idempotent per turn).
    const payload = IntentPayload.parse({
      agentId: agent.id,
      input: req.input,
      sessionId: req.sessionId ?? null,
      model: req.model ?? agent.model,
    })
    let intentId: string
    if (existing !== undefined) {
      const intent = IntentRow.parse(existing)
      if (intent.state === 'failed')
        throw new HttpError(422, 'admission_refused', 'This message was refused earlier.')
      intentId = intent.id
    } else {
      intentId = randomUUID()
      const now = new Date().toISOString()
      db.sqlite
        .prepare(
          `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(intentId, KIND, req.turnId, JSON.stringify(payload), now, now)
    }
    // 2. Admission: the run row and the room's streaming reply, in one observation.
    const known = db.sqlite
      .prepare('SELECT id FROM runs WHERE score_turn_id = ?')
      .get(req.turnId) as { id: string } | undefined
    const runId = known?.id ?? `cr_${randomUUID()}`
    const room = this.roomOf(req.turnId)
    const resumed = room ? cliSessionFor(db.sqlite, room, agent.id) : null
    await ingest.submit({
      source: `coding:${agent.id}`,
      identity: `admitted:${intentId}`,
      apply({ sqlite, now }) {
        const inserted = sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, score_turn_id, session_id, status, model, started_at, updated_at, runtime)
             VALUES (?, ?, 'score', ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          )
          .run(runId, agent.id, req.turnId, resumed, payload.model, now, now, agent.runtime)
        return [
          ...(inserted.changes ? [runDraft(sqlite, runId)] : []),
          ...attachRunMessage(sqlite, req.turnId, runId, now),
        ]
      },
    })
    db.sqlite
      .prepare(
        "UPDATE command_intents SET state = 'accepted', result = ?, updated_at = ? WHERE id = ?",
      )
      .run(runId, new Date().toISOString(), intentId)
    // The reply was cancelled while it was being admitted: nothing to run.
    if (isCancelledTurn(db.sqlite, req.turnId)) {
      await this.finish(newTranslation(runId, agent.id, room), {
        status: 'cancelled',
        costKind: driver.runtime === 'claude-code' ? 'estimated' : 'unknown',
      })
      return { runId }
    }
    // Closed while the turn was being admitted: end it visibly, never spawn it.
    if (this.closed) {
      await this.finish(newTranslation(runId, agent.id, room), {
        status: 'interrupted',
        error: TERMINAL_NOTE.interrupted,
        costKind: 'unknown',
      })
      throw new HttpError(
        503,
        'shutting_down',
        'Score is shutting down. Try again once it has restarted.',
      )
    }
    let settleEnded = (): void => undefined
    const entry: ActiveRun = {
      agentId: agent.id,
      runId,
      turnId: req.turnId,
      ended: new Promise<boolean>((resolve) => {
        settleEnded = () => resolve(!entry.unproven)
      }),
      settle: () => settleEnded(),
    }
    this.active.set(runId, entry)
    // One turn per coding agent at a time: later turns wait their turn (the run shows as queued).
    const previous = this.queues.get(agent.id) ?? Promise.resolve()
    const mine = previous.then(() =>
      this.execute(entry, agent, payload.input, room, payload.model).catch((error: unknown) =>
        // Preparing the turn failed (settings folder, spawn setup…): end the run and the reply, never leave it queued.
        this.finish(newTranslation(runId, agent.id, room), {
          status: 'failed',
          error: `Could not prepare the run: ${oneLine(error instanceof Error ? error.message : String(error), 200)}`,
          costKind: 'unknown',
        }).then(() => this.deps.onError?.(error)),
      ),
    )
    const tail = mine
      .catch((error: unknown) => this.deps.onError?.(error))
      .finally(() => entry.settle())
    this.queues.set(agent.id, tail)
    void tail.finally(() => {
      // A result still waiting to be saved keeps the entry (S3-004): it goes once the delivery has committed.
      const delivery = this.deliveries.get(runId)
      if (delivery) void delivery.finally(() => this.active.delete(runId))
      else this.active.delete(runId)
      if (this.queues.get(agent.id) === tail) this.queues.delete(agent.id)
    })
    return { runId }
  }

  private assertOpen(): void {
    if (this.closed)
      throw new HttpError(
        503,
        'shutting_down',
        'Score is shutting down. Try again once it has restarted.',
      )
  }

  /**
   * Stop says what really happened. A run this process holds gets the request (its end arrives through the normal
   * terminal path). Otherwise durable state decides: a run still queued never launched, so it is cancelled; a recorded
   * process group is stopped and, if that can't be proven in a moment, the answer is `unconfirmed` while the kill goes
   * on in the background; no record and an ended run means there is nothing to stop.
   */
  async stopRun(req: { agentId: string; runId: string }): Promise<StopOutcome> {
    const entry = this.active.get(req.runId)
    if (entry) {
      if (entry.agentId !== req.agentId) return 'not_running'
      this.requestStop(entry, 'user')
      // Nothing was ever started (still queued behind another turn, or stopped before launch): there is nothing to
      // prove, and nothing will launch.
      if (!entry.launched) return 'stopped'
      // `stopped` is a proof: the group is gone (X4). The stop goes on in the background if it takes longer.
      return Promise.race([
        entry.ended.then((gone) => (gone ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
    }
    const { sqlite } = this.deps.db
    const run = sqlite
      .prepare('SELECT status, profile FROM runs WHERE id = ? AND runtime != ?')
      .get(req.runId, 'hermes') as { status: string; profile: string } | undefined
    if (!run || run.profile !== req.agentId) return 'not_running'
    const record = this.recordOf(req.runId)
    if (record) {
      const reaping = this.reapInBackground(req.runId)
      const answer = await Promise.race([
        reaping.then((gone) => (gone ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
      return answer
    }
    const launches = this.deps.unit?.openLaunchesOf(req.runId) ?? []
    if (launches.length > 0) {
      const unit = this.deps.unit!
      const gone = Promise.all(launches.map((id) => unit.stopUnattached(id))).then((all) =>
        all.every(Boolean),
      )
      const answer = await Promise.race([
        gone.then((ok) => (ok ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
      if (answer === 'stopped' && (run.status === 'running' || run.status === 'waiting_for_approval')) {
        const agent = getCodingAgent(this.deps.db.sqlite, req.agentId, true)
        await this.finish(newTranslation(req.runId, req.agentId, this.roomOfRun(req.runId)), {
          status: 'cancelled',
          costKind: agent?.runtime === 'claude-code' ? 'estimated' : 'unknown',
          group: 'released',
        })
      }
      if (answer === 'unconfirmed') for (const id of launches) void unit.reap(id, this.deps.reapRetryMs)
      return answer
    }
    if (run.status === 'queued') {
      // Queued means the run never left the queue: the process cannot exist.
      const agent = getCodingAgent(this.deps.db.sqlite, req.agentId, true)
      await this.finish(newTranslation(req.runId, req.agentId, this.roomOfRun(req.runId)), {
        status: 'cancelled',
        costKind: agent?.runtime === 'claude-code' ? 'estimated' : 'unknown',
      })
      return 'stopped'
    }
    if (run.status === 'running' || run.status === 'waiting_for_approval') return 'unconfirmed'
    return 'not_running'
  }

  private roomOfRun(runId: string): string | null {
    const row = this.deps.db.sqlite
      .prepare('SELECT room_id FROM message_runs WHERE run_id = ?')
      .get(runId) as { room_id: string } | undefined
    return row?.room_id ?? null
  }

  private requestStop(entry: ActiveRun, reason: StopReason): void {
    if (entry.process) entry.process.stop(reason)
    else entry.stopBeforeStart ??= reason
  }

  /**
   * Saves the terminal result. The outcome is first kept in a durable pending record, then saved with a bounded
   * backoff without touching the process. If that budget runs out the result is NOT dropped: it is retried in the
   * background (up to a minute apart) until it commits, the failure is reported once, and the active entry and the
   * process record stay meanwhile. The record is also committed on restart. The CLI is never launched again (S3-004).
   */
  private async finish(translation: RunTranslation, info: TerminalInfo): Promise<unknown> {
    this.keepPending(translation, info)
    const tries = 5
    let delay = this.deps.terminalRetryMs ?? 250
    let last: unknown
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const result = await this.commitTerminal(translation, info)
        return result
      } catch (error) {
        last = error
        if (attempt < tries - 1) {
          await new Promise((r) => setTimeout(r, delay))
          delay *= 2
        }
      }
    }
    this.deps.onError?.(last)
    if (!this.deliveries.has(translation.runId) && !this.closed) {
      const loop = this.deliverInBackground(translation, info)
        .catch((error: unknown) => this.deps.onError?.(error))
        .finally(() => this.deliveries.delete(translation.runId))
      this.deliveries.set(translation.runId, loop)
    }
    return undefined
  }

  private async commitTerminal(translation: RunTranslation, info: TerminalInfo): Promise<unknown> {
    const result = await this.deps.ingest.submit(terminalObservation(translation, info))
    this.dropPending(translation.runId)
    // The terminal result is saved: the unit launch is settled and collected (design §6b). A failure here never
    // un-saves the result; recovery settles whatever was left.
    await this.deps.unit?.settleRun(translation.runId).catch((error: unknown) => this.deps.onError?.(error))
    return result
  }

  private async deliverInBackground(
    translation: RunTranslation,
    info: TerminalInfo,
  ): Promise<void> {
    let delay = this.deps.terminalRetryMs ?? 250
    for (;;) {
      await this.wait(Math.min(delay, 60_000))
      delay = Math.min(delay * 2, 60_000)
      // On shutdown the durable record is left for the next start.
      if (this.closed) return
      try {
        await this.commitTerminal(translation, info)
        return
      } catch {
        // keep trying; the first failure was reported
      }
    }
  }

  private keepPending(translation: RunTranslation, info: TerminalInfo): void {
    try {
      this.deps.db.sqlite
        .prepare(
          `INSERT OR IGNORE INTO coding_pending_terminals (run_id, agent_id, room_id, usage, info, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          translation.runId,
          translation.agentId,
          translation.roomId,
          translation.usage ? JSON.stringify(translation.usage) : null,
          JSON.stringify(info),
          new Date().toISOString(),
        )
    } catch (error) {
      // The in-memory retry still runs; only a restart before it succeeds would lose the exact result.
      this.deps.onError?.(error)
    }
  }

  private dropPending(runId: string): void {
    try {
      this.deps.db.sqlite
        .prepare('DELETE FROM coding_pending_terminals WHERE run_id = ?')
        .run(runId)
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  /** Terminal results that were still waiting to be saved when Score stopped: committed before recovery interrupts anything. */
  private async commitPendingTerminals(): Promise<void> {
    const rows = z
      .array(
        z.object({
          run_id: z.string(),
          agent_id: z.string(),
          room_id: z.string().nullable(),
          usage: z.string().nullable(),
          info: z.string(),
        }),
      )
      .parse(
        this.deps.db.sqlite
          .prepare('SELECT * FROM coding_pending_terminals ORDER BY created_at')
          .all(),
      )
    for (const row of rows) {
      try {
        const translation = newTranslation(row.run_id, row.agent_id, row.room_id)
        if (row.usage)
          translation.usage = JSON.parse(row.usage) as NonNullable<RunTranslation['usage']>
        await this.commitTerminal(translation, JSON.parse(row.info) as TerminalInfo)
      } catch (error) {
        // Stays recorded; the interruption below still ends the run if it is not terminal by then.
        this.deps.onError?.(error)
      }
    }
  }

  private async execute(
    entry: ActiveRun,
    admitted: StoredCodingAgent,
    input: string,
    room: string | null,
    /** The model admitted with the turn (`req.model ?? agent.model` at admission): what the row says is what runs. */
    model: string | null,
  ): Promise<void> {
    const { db, ingest, locator } = this.deps
    // A queued turn starts long after admission: permission, workspace and the rest are read as they are now.
    const agent = getCodingAgent(db.sqlite, admitted.id)
    if (!agent)
      return void (await this.finish(newTranslation(entry.runId, admitted.id, room), {
        status: 'failed',
        error: 'This coding agent was removed',
        costKind: 'unknown',
      }))
    const driver = driverFor(agent.runtime)
    const translation = newTranslation(entry.runId, agent.id, room)
    const costKind = agent.runtime === 'claude-code' ? 'estimated' : 'unknown'
    const stopped = (reason: StopReason): TerminalInfo => ({
      status: reason === 'shutdown' ? 'interrupted' : reason === 'user' ? 'cancelled' : 'failed',
      error:
        reason === 'shutdown'
          ? TERMINAL_NOTE.interrupted
          : reason === 'timeout'
            ? `Stopped after ${Math.round((this.deps.maxTurnMs ?? 30 * 60_000) / 60_000)} minutes`
            : reason === 'output_limit'
              ? 'Stopped: the output was too large'
              : null,
      costKind,
    })
    if (entry.stopBeforeStart)
      return void (await this.finish(translation, stopped(entry.stopBeforeStart)))
    // A queued turn may start long after admission: the CLI may have been replaced meanwhile.
    const refusal = await this.cliRefusal(agent, driver, true)
    if (refusal)
      return void (await this.finish(translation, {
        status: 'failed',
        error: refusal.notice,
        costKind,
      }))
    // An earlier turn's tools may still be running (its group was never proven gone): no new turn until they have ended.
    if (this.hasUnresolvedGroup(agent.id))
      return void (await this.finish(translation, {
        status: 'failed',
        error: UNRESOLVED_NOTE,
        costKind,
      }))
    // The folder may have changed since admission.
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok)
      return void (await this.finish(translation, {
        status: 'failed',
        error: `The workspace is unavailable: ${checked.reason}`,
        costKind,
      }))
    // The final check before launching: a Stop or shutdown that arrived during the awaits above ends the turn unlaunched.
    if (entry.stopBeforeStart)
      return void (await this.finish(translation, stopped(entry.stopBeforeStart)))
    let settingsPath: string | null = null
    const settings = driver.settingsFile?.(this.denyPaths(), this.denyFiles())
    if (settings) {
      const dir = join(this.deps.home, 'coding', agent.id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      settingsPath = join(dir, settings.name)
      writeFileSync(settingsPath, settings.content, { mode: 0o600 })
      chmodSync(settingsPath, 0o600)
    }
    let resume = room ? cliSessionFor(db.sqlite, room, agent.id) : null
    // Event numbers keep counting across attempts: they name the observations, and a fallback's must not collide.
    let index = 0
    // One wall-clock budget for the whole turn, whichever launch it takes.
    const turnMs = this.deps.maxTurnMs ?? 30 * 60_000
    const deadline = Date.now() + turnMs
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: Extract<CodingEvent, { kind: 'result' }> | undefined
      let text = ''
      // Anything the CLI did besides naming its session and reporting a result.
      let worked = false
      // Between fallback attempts too: nothing launches once Stop or shutdown has been asked for.
      if (entry.stopBeforeStart)
        return void (await this.finish(translation, stopped(entry.stopBeforeStart)))
      const parser = driver.createParser({ cwd: checked.real })
      const command = locator.nativeCommand(driver)
      if (!command.ok)
        return void (await this.finish(translation, {
          status: 'failed',
          error: command.message,
          costKind,
        }))
      const { file, args } = command
      // Not a visible queued -> running step for a turn that has been stopped already.
      if (entry.stopBeforeStart)
        return void (await this.finish(translation, stopped(entry.stopBeforeStart)))
      await ingest
        .submit(runningObservation(translation))
        .catch((error: unknown) => this.deps.onError?.(error))
      if (entry.stopBeforeStart)
        return void (await this.finish(translation, stopped(entry.stopBeforeStart)))
      const cliArgs = [
        ...args,
        ...driver.buildArgs({
          workspace: checked.real,
          prompt: input,
          permission: agent.permission,
          model,
          sessionId: resume,
          settingsPath,
          denyPaths: this.denyPaths(),
          denyFiles: this.denyFiles(),
        }),
      ]
      const stdin = driver.promptVia === 'stdin' ? input : ''
      // Saving an event can fail. The supervised backend stops the run and the result is not used (design §4); the
      // fallback keeps the run going but cannot call it complete either.
      let ingestFailed = false
      const handleEvent = async (event: CodingEvent): Promise<void> => {
        if (event.kind === 'result') result = event
        if (event.kind === 'text') text += event.text
        if (event.kind !== 'session' && event.kind !== 'result') worked = true
        await ingest.submit(eventObservation(translation, event, index++))
      }
      let outcome: Attempt
      const unit = this.deps.unit?.usable() ? this.deps.unit : undefined
      if (unit) {
        const unitRun = unit.launch({
          agentId: agent.id,
          runtime: agent.runtime,
          runId: entry.runId,
          turnId: entry.turnId,
          generation: attempt,
          command: { file, args: cliArgs, env: locator.childEnv(), cwd: checked.real, stdin },
          parser,
          onEvent: handleEvent,
          deadline,
          graceMs: this.deps.graceMs ?? 5_000,
          authorised: () => !entry.stopBeforeStart && !this.closed && !this.hasUnresolvedGroup(agent.id),
        })
        // Stop must wait for proof from here on: the unit may be starting.
        entry.launched = true
        entry.process = unitRun
        if (entry.stopBeforeStart) unitRun.stop(entry.stopBeforeStart)
        const done = await unitRun.done
        entry.process = undefined
        const exec = done.reasons.includes('supervisor-error:spawn')
        outcome = {
          exitCode: done.exitCode,
          signal: done.signal,
          stopped: done.stopped,
          stderr: done.stderr,
          spawnError: exec
            ? done.stderr.startsWith('pdeathsig-exec: cannot run')
              ? 'exec_failed'
              : 'spawn_failed'
            : done.exitCode === 127 && done.stderr.startsWith('pdeathsig-exec: cannot run')
              ? 'exec_failed'
              : null,
          leftovers: done.leftovers,
          groupGone: done.proven,
          complete: done.complete,
          refusal: done.refusal,
          reasons: done.reasons,
          launchId: done.launchId,
        }
      } else {
        const spawnOptions: Parameters<typeof spawnCli>[0] = {
          file,
          args: cliArgs,
          cwd: checked.real,
          env: locator.childEnv(),
          onSpawn: (pid) => {
            this.recordProcess(entry.runId, pid)
            entry.launched = true
          },
          onMembers: (members) => this.recordMembers(entry.runId, members),
          onMembersError: (error) => this.deps.onError?.(error),
          stdin,
          parser,
          maxMs: Math.max(1, deadline - Date.now()),
          graceMs: this.deps.graceMs ?? 5_000,
          onEvent: (event) =>
            handleEvent(event).catch((error: unknown) => {
              ingestFailed = true
              this.deps.onError?.(error)
            }),
        }
        let run: CliRun
        try {
          run = (this.deps.spawn ?? spawnCli)(spawnOptions)
        } catch (error) {
          // The process is already being killed: report nothing until it is proven gone.
          if (error instanceof SpawnRecordError) {
            await error.terminated.catch(() => false)
            throw error.original
          }
          throw error
        }
        entry.process = run
        if (entry.stopBeforeStart) run.stop(entry.stopBeforeStart)
        const done = await run.done
        entry.process = undefined
        outcome = {
          exitCode: done.exitCode,
          signal: done.signal,
          stopped: done.stopped,
          stderr: done.stderr,
          spawnError: done.spawnError,
          leftovers: done.leftovers,
          groupGone: done.groupGone,
          complete: !ingestFailed,
          refusal: null,
          reasons: ingestFailed ? ['ingest-failure'] : [],
          launchId: null,
        }
      }
      if (!outcome.groupGone) entry.unproven = true
      const stderr = oneLine(outcome.stderr, 400)
      // A resumed session the CLI refused before doing anything: start fresh once, and forget the dead id. Only with
      // proof that nothing ran: the first group is gone, no output or tool call was seen, and the CLI itself said the
      // session is unknown (a generic "not found" proves nothing). The second launch shares the turn's deadline.
      if (
        attempt === 0 &&
        resume &&
        outcome.groupGone &&
        outcome.refusal === null &&
        !worked &&
        !outcome.stopped &&
        !outcome.spawnError &&
        outcome.complete &&
        deadline - Date.now() > 0 &&
        (outcome.exitCode !== 0 || result?.ok === false) &&
        refusesResume(driver, result?.error ?? stderr)
      ) {
        // Proven gone and nothing is being finished: the record goes now so the second launch can write its own.
        if (outcome.launchId) await unit?.settleLaunch(outcome.launchId, 'retried')
        else this.forgetProcess(entry.runId)
        if (room) forgetCliSession(db.sqlite, room, agent.id)
        resume = null
        continue
      }
      const verdict = result?.verdict
      const ran = outcome.refusal === null
      let info: TerminalInfo
      if (outcome.stopped) info = stopped(outcome.stopped)
      else if (outcome.refusal) info = { status: 'failed', error: outcome.refusal, costKind }
      else if (outcome.spawnError)
        info = {
          status: 'failed',
          error:
            outcome.spawnError === 'python_unavailable'
              ? outcome.stderr
              : `Could not start ${driver.label} (${outcome.spawnError}).`,
          costKind,
        }
      else if (!outcome.complete)
        info = {
          status: 'failed',
          output: text || null,
          error: `Score couldn’t keep a complete record of this run, so its answer wasn’t used${
            outcome.reasons.length ? ` (${outcome.reasons.slice(0, 3).join(', ')})` : ''
          }.`,
          costKind,
        }
      else if (result && !result.ok)
        info = {
          status: 'failed',
          output: text || null,
          error: result.error ?? 'The run failed',
          costKind,
        }
      // The pinned driver's rule (design §6): explicit success with an authoritative reply, a clean exit and nothing
      // stopped it. A zero exit alone, or streamed commentary, never makes a result.
      else if (verdict?.eligible && outcome.exitCode === 0 && outcome.signal === null)
        info = { status: 'completed', output: verdict.reply, reply: verdict.reply, costKind }
      else
        info = {
          status: 'failed',
          output: text || null,
          error: `${driver.label} ended without a result Score can use${
            outcome.exitCode === null ? '' : ` (exit ${outcome.exitCode})`
          }${verdict?.reason ? `: ${verdict.reason}` : stderr ? `: ${stderr}` : ''}`,
          costKind,
        }
      // Plans and hand-offs read only an eligible authoritative reply (design v3 §5).
      if (ran && info.reply === undefined) info.reply = null
      if (outcome.launchId)
        unit?.noteEligibility(
          outcome.launchId,
          info.status === 'completed' ? 'eligible' : (verdict?.reason ?? outcome.reasons.join(', ')) || info.status,
        )
      if (outcome.leftovers && info.status === 'completed')
        info.output =
          `${info.output ?? ''}\n\nSome programs the agent started were still running when it finished, so Score stopped them.`.trim()
      // The record goes in the same transaction as the result, and only with proof the group ended. Without it the run
      // still ends (the reply is shown) but is marked unconfirmed, the record stays, and Score keeps stopping it.
      info.group = outcome.groupGone ? 'released' : 'unconfirmed'
      if (!outcome.groupGone)
        info.error =
          `${info.error ?? ''} Some programs the agent started couldn’t be stopped. ${UNRESOLVED_NOTE}`.trim()
      if (info.error) info.error = redact(info.error)
      await this.finish(translation, info)
      if (!outcome.groupGone) {
        if (outcome.launchId) void unit?.reap(outcome.launchId, this.deps.reapRetryMs)
        else void this.reapInBackground(entry.runId)
      }
      return
    }
  }

  /**
   * On start (review 2026-10-09, 7.2 #3): a CLI child dies with Score, so a turn still marked running or queued is
   * interrupted with a note. The CLI session id stays, so the next message resumes it.
   */
  /**
   * Durable before anything reads the child's output: the detached child is its own group leader (pgid = pid). A plain
   * insert: a record that is still there belongs to a group nobody proved gone, and is never overwritten (the throw
   * makes the new group be killed).
   */
  private recordProcess(runId: string, pid: number): void {
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, pid, pid, processStart(pid), bootId(), new Date().toISOString())
  }
  private forgetProcess(runId: string): void {
    const { sqlite } = this.deps.db
    sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(runId)
    sqlite.prepare('DELETE FROM coding_process_members WHERE run_id = ?').run(runId)
  }

  /** Identities of the group's members, recorded while Score supervises it (N4). */
  private recordMembers(runId: string, members: MemberIdentity[]): void {
    const boot = bootId()
    const now = new Date().toISOString()
    const insert = this.deps.db.sqlite.prepare(
      'INSERT OR IGNORE INTO coding_process_members (run_id, pid, start_time, boot_id, seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    const { sqlite } = this.deps.db
    sqlite.exec('BEGIN')
    try {
      for (const member of members) insert.run(runId, member.pid, member.startTime, boot, now)
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  private membersOf(runId: string): MemberIdentity[] {
    return this.deps.db.sqlite
      .prepare('SELECT pid, start_time FROM coding_process_members WHERE run_id = ?')
      .all(runId)
      .map((row) => MemberRow.parse(row))
      .map((row) => ({ pid: row.pid, startTime: row.start_time }))
  }

  private recordOf(runId: string) {
    const row = this.deps.db.sqlite
      .prepare('SELECT * FROM coding_processes WHERE run_id = ?')
      .get(runId)
    return row === undefined ? null : ProcessRow.parse(row)
  }

  /** A process group of this agent that was never proven gone: the agent takes no new turn until it is. */
  private hasUnresolvedGroup(agentId: string): boolean {
    if ((this.deps.unit?.held(agentId).length ?? 0) > 0) return true
    return (
      this.deps.db.sqlite
        .prepare(
          `SELECT 1 FROM coding_processes cp JOIN runs r ON r.id = cp.run_id WHERE r.profile = ? AND cp.unresolved = 1`,
        )
        .get(agentId) !== undefined
    )
  }

  private readonly reapers = new Map<string, Promise<boolean>>()
  private readonly wakers = new Set<() => void>()
  /** A wait that close() ends early. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      timer.unref()
      this.wakers.add(wake)
    })
  }

  /**
   * Stops a recorded group until it is proven gone, then drops the record. Retries with a bounded backoff (the
   * answer for a caller is the first attempt's); one loop per run. Resolves true once the record is gone.
   */
  private reapInBackground(runId: string): Promise<boolean> {
    const known = this.reapers.get(runId)
    if (known) return known
    const loop = (async () => {
      let delay = this.deps.reapRetryMs ?? 2000
      for (let first = true; ; first = false) {
        if (!first) {
          await this.wait(delay)
          delay = Math.min(delay * 2, 60_000)
        }
        const record = this.recordOf(runId)
        if (!record) return true
        const outcome = await this.stopGroup(record)
        if (outcome === 'gone') {
          this.forgetProcess(runId)
          return true
        }
        this.markUnobservable(runId, outcome === 'unobservable')
        if (this.closed) return false
      }
    })()
      .catch((error: unknown) => {
        this.deps.onError?.(error)
        return false
      })
      .finally(() => this.reapers.delete(runId))
    this.reapers.set(runId, loop)
    return loop
  }

  private markUnobservable(runId: string, value: boolean): void {
    this.deps.db.sqlite
      .prepare('UPDATE coding_processes SET unobservable = ? WHERE run_id = ?')
      .run(value ? 1 : 0, runId)
  }

  private stopGroup(record: z.infer<typeof ProcessRow>): Promise<GroupOutcome> {
    return (this.deps.killGroup ?? killRecordedGroup)({
      pid: record.pid,
      pgid: record.pgid,
      startTime: record.start_time,
      bootId: record.boot_id,
      members: this.membersOf(record.run_id),
      onMembers: (members) => this.recordMembers(record.run_id, members),
    })
  }

  /** Groups of this agent that were not proven gone; `canRelease` = Score can't tell whether they are its own. */
  heldGroups(
    agentId: string,
  ): { runId: string; pgid: number; canRelease: boolean; unit?: string }[] {
    const units = (this.deps.unit?.held(agentId) ?? []).map((held) => ({
      runId: held.runId,
      pgid: 0,
      canRelease: held.canRelease,
      unit: held.unit,
    }))
    return [...this.processGroups(agentId), ...units]
  }

  private processGroups(agentId: string): { runId: string; pgid: number; canRelease: boolean }[] {
    return this.deps.db.sqlite
      .prepare(
        `SELECT cp.run_id, cp.pgid, cp.unobservable FROM coding_processes cp JOIN runs r ON r.id = cp.run_id
         WHERE r.profile = ? AND cp.unresolved = 1 ORDER BY cp.created_at`,
      )
      .all(agentId)
      .map((row) =>
        z.object({ run_id: z.string(), pgid: z.int(), unobservable: z.int() }).parse(row),
      )
      .map((row) => ({ runId: row.run_id, pgid: row.pgid, canRelease: row.unobservable === 1 }))
  }

  /**
   * The person's deliberate way out of a group Score can't attribute: the records go, the agent may take turns again,
   * and an audit row names who and when. Nothing is ever signalled. Returns how many groups were released.
   */
  release(agentId: string, by: string): number {
    const { db } = this.deps
    const rows = db.sqlite
      .prepare(
        `SELECT cp.run_id, cp.pid, cp.pgid FROM coding_processes cp JOIN runs r ON r.id = cp.run_id
         WHERE r.profile = ? AND cp.unresolved = 1 AND cp.unobservable = 1`,
      )
      .all(agentId)
      .map((row) => z.object({ run_id: z.string(), pid: z.int(), pgid: z.int() }).parse(row))
    const units = this.deps.unit?.held(agentId).filter((held) => held.canRelease) ?? []
    if (rows.length === 0 && units.length === 0)
      throw new HttpError(
        409,
        'conflict',
        'Nothing to release: Score has no unclear processes for this agent.',
      )
    const at = new Date().toISOString()
    const releasedUnits = units.length > 0 ? (this.deps.unit?.releaseHeld(agentId) ?? []) : []
    for (const released of releasedUnits)
      db.sqlite
        .prepare(
          'INSERT INTO coding_releases (agent_id, run_id, pid, pgid, released_by, released_at) VALUES (?, ?, 0, 0, ?, ?)',
        )
        .run(agentId, released.runId, by, at)
    db.tx((sqlite) => {
      for (const row of rows) {
        sqlite
          .prepare(
            'INSERT INTO coding_releases (agent_id, run_id, pid, pgid, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(agentId, row.run_id, row.pid, row.pgid, by, at)
        sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(row.run_id)
        sqlite.prepare('DELETE FROM coding_process_members WHERE run_id = ?').run(row.run_id)
      }
    })
    return rows.length + releasedUnits.length
  }

  async recover(): Promise<number> {
    const { db } = this.deps
    await this.commitPendingTerminals()
    // Children can outlive a crashed Score: stop what is left of each recorded group before admitting anything. A
    // record goes only when the group is proven gone; otherwise it stays (the agent takes no new turn), the run says
    // so, and Score keeps trying in the background.
    const records = db.sqlite
      .prepare('SELECT * FROM coding_processes')
      .all()
      .map((row) => ProcessRow.parse(row))
    const unresolved = new Set<string>()
    // Supervised units first (journal <-> database <-> units <-> receipts, design §6b): each unsettled launch is
    // stopped and proven ended; one that may have executed and can't be proven is held, like an unresolved group.
    const unit = this.deps.unit
    const recovered = unit ? await unit.recover() : null
    if (recovered) {
      if (recovered.unreadable) this.deps.onError?.(new Error(recovered.unreadable))
      if (recovered.orphans.length > 0) this.deps.onOrphans?.(recovered.orphans)
      for (const launch of recovered.launches)
        if (!launch.ended) {
          unresolved.add(launch.runId)
          void unit!.reap(launch.launchId, this.deps.reapRetryMs)
        }
    }
    for (const record of records) {
      const outcome = await this.stopGroup(record)
      if (outcome === 'gone') this.forgetProcess(record.run_id)
      else {
        unresolved.add(record.run_id)
        db.sqlite
          .prepare('UPDATE coding_processes SET unresolved = 1, unobservable = ? WHERE run_id = ?')
          .run(outcome === 'unobservable' ? 1 : 0, record.run_id)
        void this.reapInBackground(record.run_id)
      }
    }
    const rows = z
      .array(z.object({ id: z.string(), profile: z.string() }))
      .parse(
        db.sqlite
          .prepare(
            "SELECT id, profile FROM runs WHERE runtime != 'hermes' AND status IN ('queued','running','waiting_for_approval')",
          )
          .all(),
      )
    for (const row of rows) {
      const turn = db.sqlite
        .prepare('SELECT room_id FROM message_runs WHERE run_id = ?')
        .get(row.id) as { room_id: string } | undefined
      await this.finish(newTranslation(row.id, row.profile, turn?.room_id ?? null), {
        status: 'interrupted',
        error: unresolved.has(row.id)
          ? `${TERMINAL_NOTE.interrupted} ${UNRESOLVED_NOTE}`
          : TERMINAL_NOTE.interrupted,
        costKind: 'unknown',
        ...(unresolved.has(row.id) ? { group: 'unconfirmed' as const } : {}),
      })
    }
    // Launches whose end is proven but whose run was already terminal (a crash between the result and `settled`).
    if (recovered && unit)
      for (const launch of recovered.launches)
        if (launch.ended) await unit.settleRun(launch.runId, 'interrupted').catch((e: unknown) => this.deps.onError?.(e))
    // Anything still pending belongs to a run that is terminal now (or was interrupted just above).
    db.sqlite
      .prepare(
        "DELETE FROM coding_pending_terminals WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running','waiting_for_approval'))",
      )
      .run()
    return rows.length
  }

  /** Server shutdown: stop the children and record the turns as interrupted. */
  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) this.requestStop(entry, 'shutdown')
    await Promise.allSettled([...this.queues.values()])
    for (const wake of [...this.wakers]) wake()
    await this.deps.unit?.close()
    await Promise.allSettled([...this.reapers.values(), ...this.deliveries.values()])
  }
  get isClosed(): boolean {
    return this.closed
  }
}
