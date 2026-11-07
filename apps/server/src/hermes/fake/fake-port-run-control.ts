import { randomUUID } from 'node:crypto'
import {
  CompactFailureReasonSchema,
  RewindSkipReasonSchema,
  type BotInputEvent,
  type CompactFailureReason,
  type ContextPartKind,
  type RewindSkipReason,
  type SessionContextReading,
} from '@score/contract'
import { assertNotKanbanAttempt } from '../../domain/kanban-attempts.ts'
import { readApprovalRow } from '../../domain/approval-store.ts'
import {
  DecisionDeliveryRequestSchema,
  type CompactSessionResult,
  type HermesPort,
  type RewindSessionResult,
} from '../port.ts'
import { FakeBotTakeovers, fakeBotScreenFrame } from './fake-bot-screen.ts'
import { FakePortRuns } from './fake-port-runs.ts'

export abstract class FakePortRunControl extends FakePortRuns {
  /** Test and demo hook: the tools the fake Hermes lists for the Score MCP server (default: every orch.* tool). */
  fakeMcpTools: string[] | null = [
    'orch.plan',
    'orch.assign',
    'orch.cancel',
    'orch.ask',
    'orch.requestApproval',
    'orch.note',
    'orch.finish',
    'orch.receipt',
    'orch.check',
    'orch.vote',
  ]
  /**
   * Simulated rewind (PLAN 5.33): succeeds, undoing exactly the requested turns, unless the agent is listed in
   * `rewindSkips` (tests) or in SCORE_FAKE_REWIND_SKIP as `agent:reason,…` (e2e).
   */
  readonly rewindSkips = new Map<string, RewindSkipReason>(
    (process.env.SCORE_FAKE_REWIND_SKIP ?? '').split(',').flatMap((item) => {
      const [agent, reason] = item.split(':')
      const parsed = RewindSkipReasonSchema.safeParse(reason)
      return agent && parsed.success ? [[agent, parsed.data] as const] : []
    }),
  )
  readonly rewinds: { agentId: string; sessionId: string; turns: number }[] = []
  /**
   * Simulated compaction (PLAN 5.36): shrinks the session's fake context from 54k to 9k tokens, unless the agent is
   * listed in SCORE_FAKE_COMPACT_FAIL as `agent:reason,…` (e2e) or in `compactFailures` (tests).
   */
  readonly compactFailures = new Map<string, CompactFailureReason>(
    (process.env.SCORE_FAKE_COMPACT_FAIL ?? '').split(',').flatMap((item) => {
      const [agent, reason] = item.split(':')
      const parsed = CompactFailureReasonSchema.safeParse(reason)
      return agent && parsed.success ? [[agent, parsed.data] as const] : []
    }),
  )
  readonly compactions: { agentId: string; sessionId: string; keepRecent?: number }[] = []
  /** Sessions already compacted: their fake context is small. */
  private readonly compacted = new Set<string>()
  /** Milliseconds the simulated summarising takes (tests and e2e can see the in-flight state). */
  compactDelayMs = Number(process.env.SCORE_FAKE_COMPACT_DELAY_MS ?? 0)

  mcpTools(): Promise<string[] | null> {
    return Promise.resolve(this.fakeMcpTools)
  }
  /** Fake mode has no gateway: a restart is a no-op that answers like a confirmed one (3.7.9). */
  readonly gatewayRestarts: string[] = []
  restartGateway(agentId: string): Promise<void> {
    this.gatewayRestarts.push(agentId)
    return Promise.resolve()
  }

  readonly botTakeovers = new FakeBotTakeovers()
  async botScreenStatus(agentId: string, viewer?: string) {
    return this.botTakeovers.status(agentId, viewer, this.scheduler.now())
  }
  async botScreenFrame(agentId: string, viewer?: string) {
    const status = this.botTakeovers.status(agentId, viewer, this.scheduler.now())
    return status.state === 'running' ? fakeBotScreenFrame(agentId, this.scheduler.now()) : status
  }
  async botScreenTake(agentId: string, owner: string) {
    return this.botTakeovers.take(agentId, owner, this.scheduler.now(), randomUUID())
  }
  async botScreenInput(
    agentId: string,
    owner: string,
    takeoverId: string,
    events: readonly BotInputEvent[],
  ) {
    return this.botTakeovers.input(agentId, owner, takeoverId, events.length, this.scheduler.now())
  }
  botScreenHeartbeat(agentId: string, owner: string, takeoverId: string) {
    return this.botTakeovers.heartbeat(agentId, owner, takeoverId, this.scheduler.now())
  }
  async botScreenHandBack(agentId: string, owner: string, takeoverId: string) {
    return this.botTakeovers.handBack(agentId, owner, takeoverId, this.scheduler.now())
  }
  async stopRun(req: { agentId: string; runId: string }): Promise<void> {
    assertNotKanbanAttempt(req.runId)
    // A run waiting for an answer is released (it does not continue).
    const waiting = this.questions.get(req.runId)
    if (waiting && this.runs.get(req.runId)?.agentId === req.agentId) {
      this.questions.delete(req.runId)
      waiting.resolve(null)
    }
    return this.enqueue(async () => {
      this.requireSink()
      if (this.runs.get(req.runId)?.agentId !== req.agentId) return
      await this.transitionRun(req.runId, 'cancelled')
    })
  }

  rewindSession(req: Parameters<HermesPort['rewindSession']>[0]): Promise<RewindSessionResult> {
    const reason = this.rewindSkips.get(req.agentId)
    if (reason) return Promise.resolve({ status: 'skipped', reason })
    if (req.dryRun) return Promise.resolve({ status: 'ready' })
    this.rewinds.push({ agentId: req.agentId, sessionId: req.sessionId, turns: req.turns })
    return Promise.resolve({
      status: 'rewound',
      turnsUndone: req.turns,
      rewoundCount: req.turns * 2,
    })
  }

  async compactSession(
    req: Parameters<NonNullable<HermesPort['compactSession']>>[0],
  ): Promise<CompactSessionResult> {
    if (this.compactDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.compactDelayMs))
    const reason = this.compactFailures.get(req.agentId)
    if (reason) return { status: 'failed', reason }
    if (this.compacted.has(req.sessionId)) return { status: 'nothing' }
    this.compactions.push({
      agentId: req.agentId,
      sessionId: req.sessionId,
      ...(req.keepRecent === undefined ? {} : { keepRecent: req.keepRecent }),
    })
    this.compacted.add(req.sessionId)
    return {
      status: 'compacted',
      before: { messages: 40, tokens: 54_000 },
      after: { messages: 8 + (req.keepRecent ?? 2) * 2, tokens: 9_000 },
      summary: [
        '## Goal',
        'Ship the launch checklist and keep the team in step.',
        '',
        '## Decisions',
        '- Review each change before it merges.',
        '- Keep the release notes short.',
        '',
        '## Open',
        '- Confirm the date with the designer.',
      ].join('\n'),
    }
  }

  /** Simulated context breakdown; `SCORE_FAKE_NO_BREAKDOWN=1` plays an old plugin that cannot answer. */
  sessionContext(
    req: Parameters<NonNullable<HermesPort['sessionContext']>>[0],
  ): Promise<SessionContextReading | null> {
    if (process.env.SCORE_FAKE_NO_BREAKDOWN === '1') return Promise.resolve(null)
    const small = this.compacted.has(req.sessionId)
    const parts = small
      ? [
          ['system_prompt', 'System prompt', 3_000],
          ['tool_definitions', 'Tool definitions', 3_500],
          ['conversation', 'Messages', 2_500],
        ]
      : [
          ['system_prompt', 'System prompt', 3_000],
          ['tool_definitions', 'Tool definitions', 9_000],
          ['mcp', 'MCP tools', 4_000],
          ['skills', 'Skills', 2_000],
          ['memory', 'Memory', 1_000],
          ['conversation', 'Messages', 35_000],
        ]
    return Promise.resolve({
      window: 128_000,
      used: parts.reduce((sum, part) => sum + (part[2] as number), 0),
      model: 'fake-model',
      source: 'provider_usage',
      autoCompactAt: 64_000,
      parts: parts.map(([kind, label, tokens]) => ({
        kind: kind as ContextPartKind,
        label: label as string,
        tokens: tokens as number,
      })),
    })
  }

  deliverDecision(
    req: Parameters<HermesPort['deliverDecision']>[0],
  ): Promise<'applied' | 'not_pending' | 'failed'> {
    return this.enqueue(async () => {
      let approval = this.approvals.get(req.approvalId)
      if (!approval && this.db) {
        const row = readApprovalRow(this.db.sqlite, req.approvalId)
        if (row?.origin === 'kanban') return 'not_pending'
        if (row)
          approval = {
            id: row.id,
            status: row.status,
            phase: row.phase,
            origin: row.origin,
            agentId: row.profile,
            choices: row.choices,
            decision: null,
            actionable: true,
            linkedTo: null,
            title: row.description,
            command: row.command,
            cwd: null,
            description: row.description,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            delivery: 'none',
            blocking: null,
            refs: [],
          }
      }
      DecisionDeliveryRequestSchema.parse(req)
      if (!approval || !approval.actionable || approval.status !== 'pending' || approval.decision)
        return 'not_pending'
      if (!approval.choices.includes(req.choice)) return 'failed'
      try {
        await this.emit({
          at: 0,
          kind: 'approval.updated',
          data: {
            ...approval,
            phase: 'decided',
            status: req.choice === 'deny' ? 'denied' : 'approved',
            decision: { choice: req.choice, by: 'elsewhere', at: this.now() },
            delivery: 'applied',
          },
        })
        return 'applied'
      } catch {
        return 'failed'
      }
    })
  }
}
