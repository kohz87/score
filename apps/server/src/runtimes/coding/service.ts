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
import { runDraft } from '../../hermes/index.ts'
import type { Ingest } from '../../hub/ingest.ts'
import { redact, redactBounded } from '../../redact.ts'
import { checkRoot, type RootPolicy } from '../../workspace/policy.ts'
import { CliLocator } from './cli.ts'
import { driverFor } from './drivers.ts'
import { killRecordedGroup, processStart } from './proc.ts'
import { spawnCli, type CliRun, type StopReason } from './process.ts'
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
}

interface ActiveRun {
  agentId: string
  runId: string
  turnId: string
  /** Set once the process exists. */
  process?: CliRun
  /** Stop asked while the turn was still waiting for the agent's previous turn. */
  stopBeforeStart?: StopReason
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
const KIND = 'start_coding_run'
const TERMINAL_NOTE = {
  interrupted:
    'Score restarted while this ran. The conversation is kept, so the next message resumes it.',
} as const

function oneLine(text: string, max: number): string {
  return redactBounded(text.replace(/\s+/g, ' ').trim(), max)
}

export class CodingRuntime {
  private readonly active = new Map<string, ActiveRun>()
  private readonly queues = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: CodingRuntimeDeps) {}

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
    const entry: ActiveRun = { agentId: agent.id, runId, turnId: req.turnId }
    this.active.set(runId, entry)
    // One turn per coding agent at a time: later turns wait their turn (the run shows as queued).
    const previous = this.queues.get(agent.id) ?? Promise.resolve()
    const mine = previous.then(() =>
      this.execute(entry, agent, payload.input, room).catch((error: unknown) =>
        // Preparing the turn failed (settings folder, spawn setup…): end the run and the reply, never leave it queued.
        this.finish(newTranslation(runId, agent.id, room), {
          status: 'failed',
          error: `Could not prepare the run: ${oneLine(error instanceof Error ? error.message : String(error), 200)}`,
          costKind: 'unknown',
        }).then(() => this.deps.onError?.(error)),
      ),
    )
    const tail = mine.catch((error: unknown) => this.deps.onError?.(error))
    this.queues.set(agent.id, tail)
    void tail.finally(() => {
      this.active.delete(runId)
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

  async stopRun(req: { agentId: string; runId: string }): Promise<void> {
    const entry = this.active.get(req.runId)
    if (!entry || entry.agentId !== req.agentId) return
    this.requestStop(entry, 'user')
  }

  private requestStop(entry: ActiveRun, reason: StopReason): void {
    if (entry.process) entry.process.stop(reason)
    else entry.stopBeforeStart ??= reason
  }

  private finish(translation: RunTranslation, info: TerminalInfo): Promise<unknown> {
    return this.deps.ingest
      .submit(terminalObservation(translation, info))
      .catch((error: unknown) => this.deps.onError?.(error))
  }

  private async execute(
    entry: ActiveRun,
    admitted: StoredCodingAgent,
    input: string,
    room: string | null,
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
    // The folder may have changed since admission.
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok)
      return void (await this.finish(translation, {
        status: 'failed',
        error: `The workspace is unavailable: ${checked.reason}`,
        costKind,
      }))
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
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: Extract<CodingEvent, { kind: 'result' }> | undefined
      let text = ''
      let worked = false
      const parser = driver.createParser({ cwd: checked.real })
      const { file, args } = locator.command(driver)
      await ingest
        .submit(runningObservation(translation))
        .catch((error: unknown) => this.deps.onError?.(error))
      const run = spawnCli({
        file,
        args: [
          ...args,
          ...driver.buildArgs({
            workspace: checked.real,
            prompt: input,
            permission: agent.permission,
            model: agent.model,
            sessionId: resume,
            settingsPath,
            denyPaths: this.denyPaths(),
            denyFiles: this.denyFiles(),
          }),
        ],
        cwd: checked.real,
        env: locator.childEnv(),
        onSpawn: (pid) => this.recordProcess(entry.runId, pid),
        stdin: driver.promptVia === 'stdin' ? input : '',
        parser,
        maxMs: this.deps.maxTurnMs ?? 30 * 60_000,
        graceMs: this.deps.graceMs ?? 5_000,
        onEvent: async (event) => {
          if (event.kind === 'result') result = event
          if (event.kind === 'text') text += event.text
          if (event.kind === 'text' || event.kind === 'tool_start') worked = true
          await ingest
            .submit(eventObservation(translation, event, index++))
            .catch((error: unknown) => this.deps.onError?.(error))
        },
      })
      entry.process = run
      if (entry.stopBeforeStart) run.stop(entry.stopBeforeStart)
      const outcome = await run.done
      entry.process = undefined
      this.forgetProcess(entry.runId)
      const stderr = oneLine(outcome.stderr, 400)
      // A resumed session the CLI no longer has: start fresh once, and forget the dead id.
      if (
        attempt === 0 &&
        resume &&
        !worked &&
        !outcome.stopped &&
        (outcome.exitCode !== 0 || result?.ok === false) &&
        /no (?:conversation|session|rollout)|not found|could not (?:resume|find)|unknown session/i.test(
          `${stderr} ${result?.error ?? ''}`,
        )
      ) {
        if (room) forgetCliSession(db.sqlite, room, agent.id)
        resume = null
        continue
      }
      let info: TerminalInfo
      if (outcome.stopped) info = stopped(outcome.stopped)
      else if (outcome.spawnError)
        info = {
          status: 'failed',
          error: `Could not start ${driver.label} (${outcome.spawnError}).`,
          costKind,
        }
      else if (result)
        info = result.ok
          ? { status: 'completed', output: result.text ?? text, costKind }
          : {
              status: 'failed',
              output: text || null,
              error: result.error ?? 'The run failed',
              costKind,
            }
      else if (outcome.exitCode === 0 && text)
        info = { status: 'completed', output: text, costKind }
      else
        info = {
          status: 'failed',
          output: text || null,
          error: `${driver.label} ended without a result${
            outcome.exitCode === null ? '' : ` (exit ${outcome.exitCode})`
          }${stderr ? `: ${stderr}` : ''}`,
          costKind,
        }
      if (info.error) info.error = redact(info.error)
      await this.finish(translation, info)
      return
    }
  }

  /**
   * On start (review 2026-10-09, 7.2 #3): a CLI child dies with Score, so a turn still marked running or queued is
   * interrupted with a note. The CLI session id stays, so the next message resumes it.
   */
  /** Durable before anything reads the child's output: the detached child is its own group leader (pgid = pid). */
  private recordProcess(runId: string, pid: number): void {
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO coding_processes (run_id, pid, pgid, start_time, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET pid = excluded.pid, pgid = excluded.pgid, start_time = excluded.start_time`,
      )
      .run(runId, pid, pid, processStart(pid), new Date().toISOString())
  }
  private forgetProcess(runId: string): void {
    this.deps.db.sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(runId)
  }

  async recover(): Promise<number> {
    const { db } = this.deps
    // Children can outlive a crashed Score: stop what is left of each recorded group before admitting anything.
    const survivors = z
      .array(
        z.object({
          run_id: z.string(),
          pid: z.int(),
          pgid: z.int(),
          start_time: z.string().nullable(),
        }),
      )
      .parse(db.sqlite.prepare('SELECT * FROM coding_processes').all())
    for (const record of survivors) {
      await killRecordedGroup({
        pid: record.pid,
        pgid: record.pgid,
        startTime: record.start_time,
      })
      this.forgetProcess(record.run_id)
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
        error: TERMINAL_NOTE.interrupted,
        costKind: 'unknown',
      })
    }
    return rows.length
  }

  /** Server shutdown: stop the children and record the turns as interrupted. */
  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) this.requestStop(entry, 'shutdown')
    await Promise.allSettled([...this.queues.values()])
  }
  get isClosed(): boolean {
    return this.closed
  }
}
