import { createHash } from 'node:crypto'
import type { TaskDetail } from '@score/contract'
import { requestRunApproval, respondRunApproval } from '../../domain/approvals.ts'
import { approvalDraft, patchApproval, readApprovalRow } from '../../domain/approval-store.ts'
import { createBrief, linkTask, readBriefRow } from '../../domain/briefs.ts'
import { recordKanbanDenial } from '../../domain/kanban-denials.ts'
import { completeRunMessage } from '../../domain/message-runs.ts'
import { closeRunQuestions } from '../../domain/questions.ts'
import { insertRoom, roomChanged, storeMessage, updateMessage } from '../../domain/rooms.ts'
import { projectTask, readProjectedTask, summaryDetail } from '../../domain/tasks.ts'
import { updateProjectedAgent } from '../../domain/agents.ts'
import { recordFrame } from '../../domain/watch-frames.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import { exampleAgents } from './scenario.ts'
import type { ScenarioStep } from './scenario.ts'

export function stepToObservation(
  step: ScenarioStep,
  identity: string,
  suppressed = false,
  detail?: TaskDetail,
): Observation {
  const draft = structuredClone({ type: step.kind, data: step.data })
  return {
    source: 'fake',
    identity,
    apply({ sqlite, now }) {
      if (suppressed) return []
      if (step.kind === 'task.upserted') {
        const existing = readProjectedTask(sqlite, step.data.id)
        const next = detail ?? {
          ...(existing ?? summaryDetail(step.data)),
          ...step.data,
        }
        // Run links come from run.updated steps; a task command's detail must not drop them.
        projectTask(sqlite, {
          ...next,
          runIds: [...new Set([...(existing?.runIds ?? []), ...next.runIds])],
        })
      }
      if (step.kind === 'task.activity') {
        const task = readProjectedTask(sqlite, step.data.taskId)
        if (task)
          projectTask(sqlite, {
            ...task,
            activity: [step.data.item, ...task.activity].slice(0, 50),
          })
      }
      if (step.kind === 'agent.updated')
        return [{ type: 'agent.updated', data: updateProjectedAgent(sqlite, step.data) }]
      if (step.kind === 'room.upserted') {
        // Announce a room only once it exists, so the API and the stream never disagree.
        const room = step.data
        if (!sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(room.id))
          insertRoom(
            sqlite,
            {
              id: room.id,
              name: room.name,
              kind: room.kind,
              leadAgentId: room.leadAgentId,
              members: room.members,
            },
            now,
          )
        return roomChanged(sqlite, room.id, now)
      }
      if (step.kind === 'message.created') {
        const message = step.data
        const exists = sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(message.roomId)
        if (!exists)
          insertRoom(
            sqlite,
            {
              id: message.roomId,
              name: '#activity-feed',
              kind: 'room',
              leadAgentId: 'lead',
              members: exampleAgents().map((agent) => agent.id),
            },
            now,
          )
        const events = storeMessage(sqlite, message, now)
        const tools = message.parts.find((part) => part.kind === 'tools')
        const files = message.parts.filter((part) => part.kind === 'file')
        if (tools && files.length && !message.streaming && message.author.kind === 'agent') {
          // Scripted file replies link their run to the room, just like admitted Chat turns.
          sqlite
            .prepare(
              `INSERT INTO message_runs
               (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, '', '[]', 'completed', ?) ON CONFLICT DO NOTHING`,
            )
            .run(
              message.id,
              tools.runId,
              message.roomId,
              message.author.agentId,
              message.id,
              `fake-turn:${message.id}`,
              message.id,
              message.createdAt,
            )
          for (const [seq, file] of files.entries())
            sqlite
              .prepare(
                `INSERT INTO tool_calls
                 (run_id, seq, tool, preview, status, started_at, ended_at)
                 VALUES (?, ?, 'edit_file', ?, 'ok', ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(
                tools.runId,
                seq,
                JSON.stringify({ path: file.path }),
                message.createdAt,
                message.createdAt,
              )
        }
        if (!exists && !events.some((event) => event.type === 'room.upserted'))
          events.push(...roomChanged(sqlite, message.roomId, now))
        return events
      }
      if (step.kind === 'brief.upserted') {
        // The script's brief starts with the lead's plan turn, so Flow has a hand-off to draw.
        const brief = step.data
        const planMessage = brief.id.replace(/^message-brief-/, 'message-plan-')
        if (planMessage !== brief.id)
          sqlite
            .prepare(
              `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
               VALUES (?, ?, 'lead', ?, 0, ?, ?, ?, ?, 'active', ?) ON CONFLICT DO NOTHING`,
            )
            .run(
              planMessage,
              brief.roomId,
              brief.id,
              `fake-turn:${brief.id}`,
              brief.id,
              brief.title,
              JSON.stringify(exampleAgents().map((agent) => agent.id)),
              now,
            )
        // The step itself is the event; createBrief only stores the row (and would emit the same summary).
        createBrief(
          sqlite,
          {
            id: brief.id,
            roomId: brief.roomId,
            text: brief.title,
            startedBy: brief.startedBy,
            startedAt: brief.startedAt,
          },
          now,
        )
        return [structuredClone(draft)] as ReturnType<Observation['apply']>
      }
      if (step.kind === 'lane.upserted' && step.data.briefId && step.data.block.taskId)
        if (readBriefRow(sqlite, step.data.briefId))
          linkTask(sqlite, step.data.briefId, step.data.block.taskId, 'plan', now)
      if (step.kind === 'message.completed')
        sqlite
          .prepare(
            "UPDATE message_runs SET state = 'completed' WHERE message_id = ? AND run_id IS NULL AND state = 'active'",
          )
          .run(step.data.messageId)
      if (step.kind === 'message.delta' || step.kind === 'message.completed')
        return updateMessage(
          sqlite,
          step.data.roomId,
          step.data.messageId,
          step.kind === 'message.delta' ? step.data.append : null,
          now,
        )
      if (step.kind === 'run.updated') {
        const run = step.data
        sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, model, tools_used, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, model = excluded.model, tools_used = excluded.tools_used, updated_at = excluded.updated_at`,
          )
          .run(
            run.id,
            run.agentId,
            run.origin,
            run.status,
            run.startedAt,
            run.endedAt,
            run.model,
            JSON.stringify(run.toolsUsed),
            now,
          )
        // Runs carry their task as a ref; the task detail lists its runs (Now › Score lanes read them).
        for (const ref of run.refs) {
          if (ref.kind !== 'task') continue
          const task = readProjectedTask(sqlite, ref.taskId)
          if (task && !task.runIds.includes(run.id))
            projectTask(sqlite, { ...task, runIds: [...task.runIds, run.id] })
        }
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
          return [
            structuredClone(draft) as DomainEventDraft,
            ...closeRunQuestions(sqlite, run.id, now),
            ...completeRunMessage(sqlite, run.id, now, {
              handoffs: run.status === 'completed',
              status: run.status,
            }),
          ]
      }
      if (step.kind === 'watch.frame') {
        // Scripted frames get a per-agent seq like real ones; the script's own seq is only a sort hint.
        const frame = step.data
        const stored = recordFrame(sqlite, {
          agentId: frame.agentId,
          runId: frame.runId,
          at: frame.at,
          // Replaying the script (restart, loop) updates the same frame instead of adding a copy.
          callKey: `fake:${frame.at}:${frame.seq}`,
          surface: frame.surface,
          payload: (frame[frame.surface] ?? frame.terminal)!,
          caption: frame.caption,
        })
        return [{ type: 'watch.frame', data: stored }]
      }
      if (step.kind === 'approval.requested') {
        const approval = step.data
        if (approval.origin === 'kanban') {
          const ref = approval.refs.find((ref) => ref.kind === 'task')
          if (!ref || ref.kind !== 'task') return []
          return recordKanbanDenial(
            sqlite,
            {
              taskId: ref.taskId,
              runId: 1,
              patternKey: 'delete',
              commandDigest: createHash('sha256').update(approval.command).digest('hex'),
            },
            { profile: approval.agentId, id: 'fake', incarnation: 'fake' },
            approval.command,
            approval.createdAt,
            approval.id,
          )
        }
        const runId = `fake-approval-run:${approval.id}`
        sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, ?, 'score', 'waiting_for_approval', ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(runId, approval.agentId, approval.createdAt, now)
        const drafts = requestRunApproval(
          sqlite,
          {
            id: approval.id,
            profile: approval.agentId,
            runId,
            requestId: approval.id,
            command: approval.command,
            description: `${approval.title}\n${approval.description}`,
            choices: approval.choices,
          },
          approval.createdAt,
        )
        patchApproval(
          sqlite,
          approval.id,
          {
            origin: approval.origin,
            blocking: approval.blocking,
            kanban_task_id: approval.refs.find((ref) => ref.kind === 'task')?.taskId ?? null,
          },
          now,
        )
        return drafts.length
          ? approvalDraft(
              sqlite,
              approval.id,
              { now: Date.parse(now) },
              drafts.some((event) => event.type === 'approval.requested'),
            )
          : []
      }
      if (step.kind === 'approval.updated') {
        const row = readApprovalRow(sqlite, step.data.id)
        if (!row) return []
        if (row.origin === 'kanban' && step.data.status === 'withdrawn') {
          patchApproval(sqlite, row.id, { closed_reason: 'task_moved', closed_at: now }, now)
          return approvalDraft(sqlite, row.id)
        }
        // The demo run that carried the approval stops waiting once it is decided or withdrawn.
        const closeRun = () => {
          if (step.data.status !== 'pending')
            sqlite
              .prepare(
                `UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'`,
              )
              .run(now, now, `fake-approval-run:${row.id}`)
        }
        if (step.data.decision) {
          const drafts = respondRunApproval(
            sqlite,
            row.profile,
            row.session_key,
            row.request_id!,
            step.data.decision.choice,
            step.data.decision.at,
          )
          closeRun()
          return drafts
        }
        patchApproval(sqlite, row.id, { blocking: step.data.blocking }, now)
        closeRun()
        return approvalDraft(sqlite, row.id, { now: Date.parse(now) })
      }
      return [structuredClone(draft)] as ReturnType<Observation['apply']>
    },
  }
}
