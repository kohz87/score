import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentDetail,
  CodingAgent,
  CodingModelsResponse,
  CodingQuota,
  CodingQuotaWindow,
  CodingUsage,
  CodingRuntime as RuntimeId,
} from '@score/contract'
import { z } from 'zod'
import { sessionOwner } from '../../domain/job-sessions.ts'
import type { QuotaSource } from '../../domain/orchestration/quota-guard.ts'
import { HttpError } from '../../errors.ts'
import { redactBounded } from '../../redact.ts'
import { checkRoot } from '../../workspace/policy.ts'
import { driverFor } from './drivers.ts'
import { instructionsEtag } from './instructions.ts'
import { aliasModels, parseAntigravityModels, readCodexModels } from './models.ts'
import { resolveOnPath } from './native-exec.ts'
import { quotaFromUsage, readCodexQuota } from './quota.ts'
import { CodingRuntimeProcesses } from './service-processes.ts'
import type { CliLocator } from './cli.ts'
import {
  forgetCliSession,
  getCodingAgent,
  getCodingQuota,
  latestCodingQuota,
  listCodingAgents,
  saveCodingQuota,
  type StoredCodingAgent,
} from './store.ts'

export class CodingRuntimeViews extends CodingRuntimeProcesses {
  isCodingAgent(id: string): boolean {
    return getCodingAgent(this.deps.db.sqlite, id) !== null
  }
  /**
   * 3.11.0 (owner): the command for a live session with this coding agent: its CLI's own interactive session, fresh (never
   * one Score is using), in the agent's workspace, as this user. Null when the agent, its CLI or its workspace is gone.
   */
  async interactiveCommand(
    agentId: string,
  ): Promise<{ file: string; args: string[]; cwd: string } | null> {
    const agent = getCodingAgent(this.deps.db.sqlite, agentId)
    if (!agent) return null
    const driver = driverFor(agent.runtime)
    const file = resolveOnPath(driver.executable, this.deps.locator.childEnv().PATH)
    if (!file) return null
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok) return null
    return { file, args: [], cwd: checked.real }
  }

  agents(): StoredCodingAgent[] {
    return listCodingAgents(this.deps.db.sqlite)
  }

  /** The agent as the front end sees it, with the CLI's state. */
  async view(agent: StoredCodingAgent): Promise<CodingAgent> {
    const driver = driverFor(agent.runtime)
    const cli = await this.deps.locator.detect(driver)
    const problem =
      cli.state === 'untested_version' && cli.version !== null
        ? await this.versionProblemShown(driver, cli.version)
        : null
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      instructions: agent.instructions,
      instructionsEtag: instructionsEtag(agent.instructions),
      runtime: agent.runtime,
      workspace: agent.workspace,
      permission: agent.permission,
      model: agent.model,
      effort: agent.effort,
      advisorModel: agent.advisorModel,
      style: agent.style,
      quota: driver.quota,
      quotaFloorPercent: agent.quotaFloorPercent,
      cli: {
        state: cli.state,
        version: cli.version,
        testedVersions: [...driver.testedVersions],
        problem,
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

  /**
   * The meters of the CLI that just ended a turn (8.1): Claude Code's latest rate-limit record from the stream, Codex's
   * from its own log of this run. Best effort, never part of the run's outcome.
   */
  protected recordQuota(
    agent: StoredCodingAgent,
    runtime: RuntimeId,
    streamed: CodingQuotaWindow[] | null,
    threadId: string | null,
    locator: CliLocator,
  ): void {
    try {
      let windows = streamed
      let source: CodingQuota['source'] = 'turn'
      if (runtime === 'codex') {
        source = 'log'
        windows =
          threadId === null
            ? null
            : readCodexQuota(locator.childEnv().CODEX_HOME, threadId, new Date())
      }
      if (windows === null || runtime === 'antigravity') return
      saveCodingQuota(this.deps.db.sqlite, agent.id, {
        runtime,
        seenAt: new Date().toISOString(),
        windows,
        source,
      })
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  /** The stored quota of one agent; Antigravity's is read from its own `/usage` (cached for a minute). */
  async quotaOf(agent: StoredCodingAgent): Promise<CodingQuota | null> {
    if (agent.runtime === 'antigravity') return quotaFromUsage(await this.usage('antigravity'))
    return getCodingQuota(this.deps.db.sqlite, agent.id)
  }

  /** The newest reading among the live agents of a runtime (the add-agent form, before any agent exists). */
  async quotaOfRuntime(runtime: RuntimeId): Promise<CodingQuota | null> {
    if (runtime === 'antigravity') return quotaFromUsage(await this.usage('antigravity'))
    return latestCodingQuota(this.deps.db.sqlite, runtime)
  }

  /**
   * What the quota guard reads (PLAN 8.6): Antigravity's cached `/usage`, refreshed when older than a minute. A
   * refresh that fails drops the reading at once (and so does age past two minutes), so a failed read never holds a
   * step (docs/API-CONTRACT.md "Quota guard"). The Quota card calls `usage()`, which throws then, so nothing shows it.
   */
  quotaSource(): QuotaSource {
    return {
      antigravity: () => {
        const cached = this.usageCache.get('antigravity')
        return cached && Date.now() - cached.at < 120_000 ? quotaFromUsage(cached.value) : null
      },
      refresh: async () => {
        if (!this.agents().some((agent) => agent.runtime === 'antigravity')) return
        await this.usage('antigravity').catch(() => this.usageCache.delete('antigravity'))
      },
    }
  }

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

  /**
   * The models the form offers for a CLI (PLAN 8.5, decision 86), cached for 5 minutes unless `fresh`. Never an error:
   * anything unreadable is `none`, and the form falls back to a free-text field. Never sends a prompt: Antigravity's
   * `agy models` is a listing command, Codex's list is a file, Claude Code's is a constant.
   */
  async models(runtime: RuntimeId, fresh = false): Promise<CodingModelsResponse> {
    const cached = this.modelsCache.get(runtime)
    if (!fresh && cached && Date.now() - cached.at < 300_000) return cached.value
    let value: CodingModelsResponse = { models: [], source: 'none' }
    try {
      const driver = driverFor(runtime)
      const cli = await this.deps.locator.detect(driver)
      if (cli.state !== 'not_installed' && cli.state !== 'not_supported') {
        const aliases = aliasModels(runtime)
        if (aliases) value = aliases
        else if (runtime === 'codex')
          value = readCodexModels(this.deps.locator.childEnv().CODEX_HOME)
        else if (runtime === 'antigravity') {
          const { file, args } = this.deps.locator.command(driver)
          const cwd = join(this.deps.home, 'coding')
          mkdirSync(cwd, { recursive: true, mode: 0o700 })
          const output = await new Promise<string>((done, fail) =>
            execFile(
              file,
              [...args, 'models'],
              { cwd, env: this.deps.locator.childEnv(), timeout: 30_000, maxBuffer: 256 * 1024 },
              (error, stdout) => (error ? fail(error) : done(stdout)),
            ),
          )
          const models = parseAntigravityModels(output)
          if (models.length) value = { models, source: 'cli' }
        }
      }
    } catch (error) {
      this.deps.onError?.(error)
    }
    if (value.source === 'none') this.modelsCache.delete(runtime)
    else this.modelsCache.set(runtime, { at: Date.now(), value })
    return value
  }

  /** Forget the CLI session of the job a Score session key belongs to (CLI sessions are per job, PLAN 11.1b). */
  forgetRoomSession(sessionKey: string, agentId: string): void {
    const owner = sessionOwner(this.deps.db.sqlite, agentId, sessionKey)
    if (owner?.jobId && !owner.continued)
      forgetCliSession(this.deps.db.sqlite, owner.jobId, agentId)
  }
}
