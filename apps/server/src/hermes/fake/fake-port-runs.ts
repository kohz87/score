import { z } from 'zod'
import { requestRunApproval } from '../../domain/approvals.ts'
import { readApprovalRow } from '../../domain/approval-store.ts'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import {
  appendRunMessage,
  attachRunMessage,
  isCancelledTurn,
  noteRunProgress,
} from '../../domain/message-runs.ts'
import { requestRunQuestion } from '../../domain/questions.ts'
import { recordFrame } from '../../domain/watch-frames.ts'
import { recordRunResult } from '../../domain/workflows/verdict.ts'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { notDispatched, type HermesPort } from '../port.ts'
import { demoQuestion, demoReply } from './fake-port-demo.ts'
import { FakePortTasks } from './fake-port-tasks.ts'
import { exampleRun } from './scenario.ts'

export abstract class FakePortRuns extends FakePortTasks {
  /**
   * Scripted agents for tests and e2e (PLAN 7.5a): called when a run starts, with the input as Hermes would receive it
   * (an orchestration capability included). May return the reply text; the run completes afterwards.
   */
  runHook?: (run: {
    agentId: string
    input: string
    turnId: string
    runId: string
  }) => Promise<{ text?: string; hold?: boolean; fail?: boolean; lose?: boolean } | void>

  private readonly refusals = new Map<string, number>()

  startRun(input: Parameters<HermesPort['startRun']>[0]): Promise<{ runId: string }> {
    const req = z
      .object({
        agentId: z.string().min(1),
        input: z.string().min(1),
        turnId: z.string().min(1),
        sessionId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        images: z.array(z.string().min(1)).optional(),
      })
      .parse(input)
    return this.enqueue(async () => {
      try {
        // Scripted outage for workflow tests and e2e: `[fake:refuse:N]` refuses the first N sends of a turn as proven
        // unsent (nothing reached Hermes); a bare `[fake:refuse]` refuses once.
        const refuse = /\[fake:refuse(?::(\d+))?\]/.exec(req.input)
        if (refuse) {
          const seen = (this.refusals.get(req.turnId) ?? 0) + 1
          this.refusals.set(req.turnId, seen)
          if (seen <= Number(refuse[1] ?? 1))
            throw new HttpError(503, 'hermes_unavailable', 'The test Hermes is unavailable.')
        }
        if (this.db) assertAgentAdmits(this.db.sqlite, input.agentId)
        this.requireSink()
        if (!this.turns.has(req.turnId) && !this.agents.has(req.agentId))
          throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      } catch (error) {
        throw notDispatched(error)
      }
      const existing = this.turns.get(req.turnId)
      if (existing) return { runId: existing }
      const runId = `fake-run:${req.turnId}`
      const startedAt = this.scheduler.now()
      const run = { ...exampleRun(req.agentId, runId, this.now()), model: req.model ?? null }
      // What Hermes would receive: an orchestration capability is filled in here, in memory, and stored nowhere.
      const wire = input.render ? input.render(req.input) : req.input
      const base = demoReply(wire, this.reply({ ...req, input: wire }))
      const seen = req.images?.length ?? 0
      // Attachment notes (PLAN 5.30) are visible in the reply so end-to-end tests can see what an agent received.
      const received = [
        ...req.input.matchAll(/^(?:Attached|Workspace file[^:\n]*|Attached file): (.+)$/gm),
      ]
        .map((match) => match[1]!.split(' (')[0]!)
        .join(', ')
      const withImages = seen
        ? { ...base, text: `${base.text} I can see ${seen} image${seen === 1 ? '' : 's'}.` }
        : base
      const response = received
        ? { ...withImages, text: `${withImages.text} I received: ${received}.` }
        : withImages
      let cancelled = false
      await this.requireSink().submit({
        source: 'fake',
        identity: `${this.sessionId}:admitted:${req.turnId}`,
        apply({ sqlite, now }) {
          cancelled = isCancelledTurn(sqlite, req.turnId)
          sqlite
            .prepare(
              `INSERT INTO runs (id, profile, origin, score_turn_id, session_id, status, model, started_at, updated_at)
            VALUES (?, ?, 'score', ?, ?, 'queued', ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .run(runId, req.agentId, req.turnId, req.sessionId ?? null, req.model ?? null, now, now)
          return [
            { type: 'run.updated', data: run },
            ...attachRunMessage(sqlite, req.turnId, runId, now),
          ]
        },
      })
      this.runs.set(runId, run)
      this.turns.set(req.turnId, runId)
      if (cancelled) {
        await this.transitionRun(runId, 'cancelled')
        return { runId }
      }
      this.schedule(Math.max(0, startedAt + 250 / this.speed - this.scheduler.now()), async () => {
        await this.transitionRun(runId, 'running')
        if (this.runs.get(runId)?.status !== 'running') return
        // Demo hook: a message that says "go quiet" leaves the run running and silent (a provider stuck retrying)
        // until it is stopped, so the stalled-reply notice can be seen.
        if (/go quiet/i.test(req.input.split('\n\nRoom context:')[0] ?? '')) return
        let replyText = response.text
        let failRun = false
        if (this.runHook) {
          const hooked = await this.runHook({
            agentId: req.agentId,
            input: wire,
            turnId: req.turnId,
            runId,
          })
          if (this.runs.get(runId)?.status !== 'running') return
          // `hold`: the run stays running and silent until it is stopped (a stuck agent).
          if (hooked?.hold) return
          // `lose`: Hermes reports the run cancelled, which is not termination evidence (the attempt is "not confirmed
          // ended"), as when a run handle is lost.
          if (hooked?.lose) {
            await this.transitionRun(runId, 'cancelled')
            return
          }
          if (hooked && typeof hooked.text === 'string') replyText = hooked.text
          failRun = hooked?.fail === true
        }
        // Demo hook (decision 128): "ask me" makes the agent ask the person and wait; "ask me to pick" offers options,
        // "ask me to choose several" lets several be picked. The reply then says what it got. The run waits outside the
        // adapter's queue, so other agents carry on meanwhile.
        const ask = demoQuestion(req.input.split('\n\nRoom context:')[0] ?? '')
        const streamReply = (replyText: string): void => {
          const chunks = replyText.match(/.{1,24}/gs) ?? []
          const stream = (index: number): void => {
            const chunk = chunks[index]
            const at =
              chunk === undefined ? Math.max(1000, 400 + chunks.length * 150) : 400 + index * 150
            this.schedule(
              Math.max(0, startedAt + at / this.speed - this.scheduler.now()),
              async () => {
                if (this.runs.get(runId)?.status !== 'running') return
                if (chunk !== undefined) {
                  await this.requireSink().submit({
                    source: 'fake',
                    identity: `${this.sessionId}:delta:${runId}:${index}`,
                    apply: ({ sqlite, now }) => [
                      ...noteRunProgress(sqlite, runId, now, { announce: false }),
                      ...appendRunMessage(sqlite, runId, chunk, now),
                    ],
                  })
                  stream(index + 1)
                } else {
                  const complete = async (): Promise<void> => {
                    await this.requireSink().submit({
                      source: 'fake',
                      identity: `${this.sessionId}:tools:${runId}`,
                      apply({ sqlite, now }) {
                        for (const [seq, tool] of response.tools.entries())
                          sqlite
                            .prepare(
                              `INSERT INTO tool_calls
                        (run_id, seq, tool, preview, status, started_at, ended_at, result_preview) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?) ON CONFLICT DO NOTHING`,
                            )
                            .run(
                              runId,
                              seq,
                              tool,
                              // File tools carry a path so the Chat "Files in play" panel has demo data.
                              tool === 'edit_file'
                                ? JSON.stringify({
                                    path: `src/${seq % 2 ? 'feed-card.css' : 'activity-feed.ts'}`,
                                  })
                                : tool === 'terminal'
                                  ? ['pnpm test', 'pnpm lint', 'git status'][seq % 3]!
                                  : null,
                              now,
                              now,
                              tool === 'terminal' ? '3 checks passed' : 'ok',
                            )
                        sqlite
                          .prepare(
                            'UPDATE runs SET input_tokens = 1200, output_tokens = 240, cost_usd = 0.0042 WHERE id = ?',
                          )
                          .run(runId)
                        // Workflow steps keep the complete-reply facts (verdict, bounded output), as the live follower does.
                        recordRunResult(sqlite, runId, replyText, now)
                        if (response.tools.length)
                          sqlite
                            .prepare(
                              'INSERT INTO run_thinking (run_id, seq, text) VALUES (?, -1, ?) ON CONFLICT DO NOTHING',
                            )
                            .run(runId, 'Check the tests first, then edit the feed.')
                        // Neutral demo frames so Watch has something to replay in fake mode.
                        const frames: DomainEventDraft[] = []
                        for (const [seq, tool] of response.tools.entries()) {
                          const path = `src/${seq % 2 ? 'feed-card.css' : 'activity-feed.ts'}`
                          const draft =
                            tool === 'terminal'
                              ? {
                                  surface: 'terminal' as const,
                                  payload: {
                                    cwd: 'demo-project',
                                    command: ['pnpm test', 'pnpm lint', 'git status'][seq % 3]!,
                                    output: '3 checks passed',
                                    status: 'ok' as const,
                                  },
                                  caption: `Ran ${['pnpm test', 'pnpm lint', 'git status'][seq % 3]!}`,
                                }
                              : tool === 'edit_file'
                                ? {
                                    surface: 'editor' as const,
                                    payload: {
                                      path,
                                      diff: `--- ${path}\n+++ ${path}\n@@ -1,1 +1,2 @@\n const demo = true\n+const edited = true\n`,
                                      language: path.endsWith('.ts') ? 'typescript' : 'css',
                                    },
                                    caption: `Edited ${path}`,
                                  }
                                : null
                          if (draft)
                            frames.push({
                              type: 'watch.frame',
                              data: recordFrame(sqlite, {
                                agentId: req.agentId,
                                runId,
                                at: now,
                                callKey: null,
                                ...draft,
                              }),
                            })
                        }
                        return frames
                      },
                    })
                    const current = this.runs.get(runId)!
                    this.runs.set(runId, { ...current, toolsUsed: [...new Set(response.tools)] })
                    await this.transitionRun(runId, failRun ? 'failed' : 'completed')
                  }
                  // Demo hook: a message that says "ask for approval" makes the run raise one and wait.
                  if (!/ask for approval/i.test(req.input.split('\n\nRoom context:')[0] ?? ''))
                    await complete()
                  else {
                    await this.requestRunApproval(runId, req.agentId)
                    const deadline = this.scheduler.now() + 600_000
                    const wait = (): void =>
                      this.schedule(250, async () => {
                        if (this.runs.get(runId)?.status !== 'waiting_for_approval') return
                        if (!this.approvalAnswered(runId) && this.scheduler.now() < deadline)
                          return wait()
                        await this.transitionRun(runId, 'running')
                        await complete()
                      })
                    wait()
                  }
                }
              },
            )
          }
          stream(0)
        }
        if (ask) {
          this.questions.set(runId, {
            promptId: `fake-q:${runId}`,
            // `null`: the run was stopped (or the adapter stopped) while it waited.
            resolve: (answer) => {
              if (answer === null) return
              this.schedule(0, async () => {
                if (this.runs.get(runId)?.status === 'running')
                  streamReply(`Thanks, going with ${answer}.`)
              })
            },
          })
          await this.requireSink().submit({
            source: 'fake',
            identity: `${this.sessionId}:question:${runId}`,
            apply: ({ sqlite, now }) =>
              requestRunQuestion(
                sqlite,
                {
                  profile: req.agentId,
                  runId,
                  promptId: `fake-q:${runId}`,
                  generation: 1,
                  question: ask.question,
                  options: ask.options,
                  multiSelect: ask.multiSelect,
                  expiresAt: null,
                },
                now,
              ),
          })
          return
        }
        streamReply(replyText)
      })
      return { runId }
    })
  }

  protected async requestRunApproval(runId: string, agentId: string): Promise<void> {
    await this.requireSink().submit({
      source: 'fake',
      identity: `${this.sessionId}:approval:${runId}`,
      apply: ({ sqlite, now }) =>
        requestRunApproval(
          sqlite,
          {
            id: `fake-approval:${runId}`,
            profile: agentId,
            runId,
            requestId: `${runId}:approval`,
            command: 'pnpm add ws@8.18.0',
            description: 'Install the websocket library\nThe run needs it to keep going.',
            choices: ['once', 'session', 'always', 'deny'],
          },
          now,
        ),
    })
    await this.transitionRun(runId, 'waiting_for_approval')
  }

  protected approvalAnswered(runId: string): boolean {
    if (!this.db) return true
    const row = readApprovalRow(this.db.sqlite, `fake-approval:${runId}`)
    return !row || row.phase !== 'human_pending'
  }

  answerQuestion(
    req: Parameters<HermesPort['answerQuestion']>[0],
  ): Promise<'applied' | 'not_pending'> {
    const waiting = this.questions.get(req.runId)
    if (!waiting || waiting.promptId !== req.promptId) return Promise.resolve('not_pending')
    this.questions.delete(req.runId)
    // A multi-select answer arrives as Hermes would get it, a JSON array of labels.
    const text = req.answer.startsWith('[')
      ? (JSON.parse(req.answer) as string[]).join(' and ')
      : req.answer
    waiting.resolve(text)
    return Promise.resolve('applied')
  }

  protected async transitionRun(
    runId: string,
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_for_approval',
  ): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running', 'waiting_for_approval'].includes(run.status)) return
    await this.emit({
      at: 0,
      kind: 'run.updated',
      data: {
        ...run,
        status,
        endedAt: status === 'running' || status === 'waiting_for_approval' ? null : this.now(),
      },
    })
  }
}
