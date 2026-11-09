import { createHash } from 'node:crypto'
import {
  AgentDetailSchema,
  type AgentDetail,
  type AgentSummary,
  type ProfileStepName,
  type SubagentSetup,
} from '@score/contract'
import { z } from 'zod'
import type { HermesSubagentConfig } from '../profile-management.ts'
import { excerpt } from '../agent-files.ts'
import { MEMORY_DETAIL_ITEMS } from '../agent-tabs.ts'
import { permissionsOf } from '../approvals.ts'
import { HttpError } from '../../errors.ts'
import type { HermesPort } from '../port.ts'
import type { ProfileInventory, ProfileStepContext } from '../profile-management.ts'
import { ProfileNameSchema } from '../live/paths.ts'
import { FakePortSettings } from './fake-port-settings.ts'
import { fakeJourneyFacts } from './journey-history.ts'
import { fakeOutsideSession, fakeOutsideSessions } from './outside-sessions.ts'
import { fakeReportHistory } from './report-history.ts'
import { exampleAgents } from './scenario.ts'

export abstract class FakePortAgents extends FakePortSettings {
  async subagentSetup(): Promise<SubagentSetup> {
    return {
      agents: (await this.listAgents()).map((agent) => ({
        agentId: agent.id,
        inline: true,
        guard: true,
      })),
    }
  }

  async applySubagentSetup(): Promise<SubagentSetup> {
    return this.subagentSetup()
  }

  refreshSubagentPolicies(): void {}

  private subagentConfigs = new Map<string, HermesSubagentConfig>()

  async subagentConfig(agentId: string): Promise<HermesSubagentConfig> {
    return (
      this.subagentConfigs.get(agentId) ?? {
        maxConcurrent: 4,
        model: null,
        maxIterations: 50,
        timeoutSeconds: null,
      }
    )
  }

  async setSubagentConfig(agentId: string, change: Partial<HermesSubagentConfig>): Promise<void> {
    this.subagentConfigs.set(agentId, { ...(await this.subagentConfig(agentId)), ...change })
  }

  async listAgents(): Promise<AgentSummary[]> {
    return structuredClone([...this.agents.values()])
  }
  async profileInventory(name: string, cloneFrom?: string): Promise<ProfileInventory> {
    ProfileNameSchema.parse(name)
    const source = cloneFrom ? this.agentOrThrow(cloneFrom) : null
    const inherited = {
      memories: source ? ['MEMORY.md', 'USER.md'] : [],
      skills: source ? (this.skills.get(source.id) ?? []).map((item) => item.name) : [],
      plugins: source ? ['score-bridge'] : [],
      approvalSettings: source ? ['mode: smart', 'command allowlist', 'deny rules'] : [],
      credentialsPresent: source ? ['example-provider'] : [],
    }
    const exists = this.agents.has(name)
    return {
      exists,
      identity: exists ? (this.profileIdentities.get(name) ?? `fake-existing:${name}`) : null,
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            this.agents.get(name),
            source,
            inherited,
            source ? this.memory.get(source.id) : null,
            source ? this.approvalConfigs.get(source.id) : null,
          ]),
        )
        .digest('hex'),
      inherited,
      blockers: [],
    }
  }
  profileExportPath(name: string, revision: string) {
    ProfileNameSchema.parse(name)
    // Fake mode never writes an archive; this is the private destination shown by the simulated adapter.
    return `${this.db ? this.profileScoreHome() : '/tmp/score-fake'}/profile-backups/${name}-${revision.slice(0, 24)}.tar.gz`
  }
  protected profileScoreHome() {
    const row = z
      .object({ file: z.string() })
      .parse(this.db!.sqlite.prepare('PRAGMA database_list').get())
    return row.file.slice(0, row.file.lastIndexOf('/'))
  }
  async describeProfile(name: string, description: string) {
    this.agentOrThrow(name).role = description
  }
  async profileStep(step: ProfileStepName, context: ProfileStepContext) {
    const name = ProfileNameSchema.parse(context.targetName)
    const input = context.input
    let current =
      this.profileIdentities.get(name) ?? (this.agents.has(name) ? `fake-existing:${name}` : null)
    if (
      step !== 'create_profile' &&
      step !== 'import_profile' &&
      !['purge_identity', 'retire'].includes(step) &&
      current !== context.targetIdentity
    )
      throw new HttpError(409, 'conflict', 'The profile changed.')
    if (step === 'create_profile') {
      if (this.agents.has(name) || !input)
        throw new HttpError(409, 'conflict', 'A profile with that name already exists.')
      // A small observable provisioning interval keeps fake mode faithful to the asynchronous operation UI.
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      const source = input.cloneFrom ? this.agentOrThrow(input.cloneFrom) : null
      this.agents.set(name, {
        ...(source ?? exampleAgents()[0]!),
        id: name,
        name: input.name,
        role: input.role,
        style: input.style,
        status: 'idle',
        activity: null,
        served: true,
      })
      if (source) {
        this.skills.set(name, structuredClone(this.skills.get(source.id) ?? []))
        this.memory.set(name, structuredClone(this.memory.get(source.id) ?? []))
        this.files.set(`${name}/SOUL.md`, this.files.get(`${source.id}/SOUL.md`) ?? '')
      }
      current = `fake:${context.operationId}`
      this.profileIdentities.set(name, current)
    } else if (step === 'import_profile') {
      if (this.agents.has(name) || !input || !context.importArchive)
        throw new HttpError(409, 'conflict', 'A profile with that name already exists.')
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      this.agents.set(name, {
        ...exampleAgents()[0]!,
        id: name,
        name: input.name,
        role: input.role,
        style: input.style,
        status: 'idle',
        activity: null,
        served: true,
      })
      current = `fake:${context.operationId}`
      this.profileIdentities.set(name, current)
    } else if (step === 'describe_profile') {
      this.agentOrThrow(name).role = input!.role
    } else if (step === 'model') {
      await this.setAgentModel(name, {
        model: input!.model,
        ...(input!.provider ? { provider: input!.provider } : {}),
      })
    } else if (step === 'permissions') {
      await this.updateApprovals(name, () => ({
        mode: context.baseline.mode,
        allowlist: context.baseline.goAhead,
        deny: context.baseline.never,
      }))
    } else if (step === 'delete_profile') {
      if (!this.profileSteps.get(name)?.has('export'))
        throw new HttpError(409, 'conflict', 'There is no verified export.')
      this.agents.delete(name)
      this.profileIdentities.delete(name)
    } else if (step === 'verify_ready') {
      const steps = this.profileSteps.get(name)
      if (
        ![
          'preserve_key',
          'configure_key',
          ...(steps?.has('import_profile') ? [] : ['model']),
          'permissions',
          'install_bridge',
          'enable_bridge',
        ].every((key) => steps?.has(key as ProfileStepName))
      )
        throw new HttpError(409, 'conflict', 'The checks after setting up the agent failed.')
    }
    const steps = this.profileSteps.get(name) ?? new Set<ProfileStepName>()
    steps.add(step)
    this.profileSteps.set(name, steps)
    if (this.db) {
      const detail = (await this.listAgentDetails()).find((agent) => agent.id === name) ?? null
      this.db.sqlite
        .prepare(
          'INSERT INTO fake_profiles (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state',
        )
        .run(
          name,
          JSON.stringify({
            detail,
            identity: current,
            steps: [...steps],
            approvals: this.approvalConfigs.get(name) ?? { mode: 'smart', allowlist: [], deny: [] },
            soul: this.files.get(`${name}/SOUL.md`) ?? '',
          }),
        )
    }
    return { identity: current ?? context.targetIdentity }
  }

  async listOutsideSessions(agentIds: string[]) {
    return fakeOutsideSessions(agentIds, this.scheduler.now(), new Set(this.agents.keys()))
  }
  async readOutsideSession(agentId: string, sessionId: string) {
    return fakeOutsideSession(agentId, sessionId, this.scheduler.now())
  }
  sessionContinuation(): 'same_session' | 'new_session' | 'unknown' {
    return 'same_session'
  }

  async reportFacts(req: Parameters<HermesPort['reportFacts']>[0]) {
    // Neutral, deterministic numbers that grow with the window so the three ranges look different.
    const days = Math.max(1, Math.ceil((req.to - req.from) / 86_400_000))
    const history = this.seedReportHistory ? fakeReportHistory(req.to, req.agentIds) : null
    if (history) {
      return {
        tasks: history.tasks,
        spendUsd: Object.fromEntries(
          req.agentIds.map((id) => [
            id,
            Math.round(days * (history.spendPerDay[id] ?? 0.5) * 100) / 100,
          ]),
        ),
      }
    }
    return {
      tasks: [...this.tasks.values()].map((task) => {
        const done = task.hermesStatus === 'done'
        const finishedAt = Date.parse(task.updatedAt)
        const sentBack = task.badge?.kind === 'changes_requested'
        const reviewed = Boolean(task.reviewer) || sentBack
        return {
          id: task.id,
          assignee: task.assignee,
          status: task.hermesStatus,
          createdAt: finishedAt - (task.elapsedSec ?? 600) * 1000,
          completedAt: done ? finishedAt : null,
          hasParents: task.dependsOn.length > 0,
          events: [
            ...(reviewed
              ? [
                  {
                    id: 1,
                    kind: 'review_requested',
                    at: finishedAt - 120_000,
                    actor: task.assignee,
                  },
                ]
              : []),
            ...(sentBack
              ? [{ id: 2, kind: 'changes_requested', at: finishedAt - 60_000, actor: null }]
              : []),
          ],
        }
      }),
      spendUsd: Object.fromEntries(
        req.agentIds.map((agentId, i) => [
          agentId,
          Math.round(days * (0.35 + 0.1 * i) * 100) / 100,
        ]),
      ),
    }
  }

  async journeyFacts(req: Parameters<HermesPort['journeyFacts']>[0]) {
    if (this.seedReportHistory)
      return fakeJourneyFacts(req.to, req.agentIds, fakeReportHistory(req.to, req.agentIds).tasks)
    return {
      tasks: [...this.tasks.values()].flatMap((task) =>
        task.hermesStatus === 'done' && task.assignee
          ? [
              {
                agentId: task.assignee,
                at: Date.parse(task.updatedAt),
                id: task.id,
                title: task.title,
              },
            ]
          : [],
      ),
      skills: [],
      memory: [],
    }
  }

  async reportHistoryRows(now: number, agentIds: string[]) {
    const { runs, approvals, spendPerDay } = fakeReportHistory(now, agentIds)
    if (!this.seedReportHistory) return { runs: [], approvals: [] }
    const base = Object.values(spendPerDay).reduce((total, value) => total + value, 0)
    // A deterministic wobble so the demo trend is not a flat line.
    const trendSpendUsd = Array.from(
      { length: 30 },
      (_, day) => Math.round(base * (0.75 + 0.5 * Math.abs(Math.sin(day * 1.7))) * 100) / 100,
    )
    return { runs, approvals, trendSpendUsd }
  }

  async listAgentDetails(): Promise<AgentDetail[]> {
    return (await this.listAgents()).map((agent) =>
      AgentDetailSchema.parse({
        ...agent,
        tagline: agent.role,
        personality: {
          excerpt: excerpt(this.files.get(`${agent.id}/SOUL.md`) ?? ''),
          source: 'SOUL.md',
        },
        reportsTo: agent.id === 'lead' ? null : 'lead',
        worksIn: null,
        rulesFile: 'AGENTS.md',
        model: agent.model
          ? {
              ...agent.model,
              via: this.models.get(agent.id)?.via ?? 'Demo',
              fallback:
                this.modelSettingsOf(agent.id)
                  .fallbacks.map((ref) => ref.model)
                  .join(', then ') || null,
            }
          : null,
        skills: structuredClone(this.skills.get(agent.id) ?? []),
        memory: structuredClone((this.memory.get(agent.id) ?? []).slice(0, MEMORY_DETAIL_ITEMS)),
        tools: structuredClone(this.tools.get(agent.id) ?? []),
        helpersMax: 3,
        routines: this.routinesOf(agent.id),
        channels: [],
        permissions: permissionsOf(this.approvalConfigs.get(agent.id) ?? null),
      }),
    )
  }
}
