import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CommandResult, Message } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { attachmentNote } from '../../domain/attachment-input.ts'
import { createBrief } from '../../domain/briefs.ts'
import { assertJobOpen } from '../../domain/exchanges/job-life.ts'
import { freezeRef } from '../../domain/exchanges/sharing.ts'
import { updateJob } from '../../domain/exchanges/store.ts'
import { defaultJobId } from '../../domain/job-sessions.ts'
import { reserveMessageRun } from '../../domain/message-runs.ts'
import { resolveAlias } from '../../domain/model-aliases.ts'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import { PLAN_FIRST_ADDENDUM } from '../../domain/plan.ts'
import { messageFromRow, readRoom, roomRow, storeMessage } from '../../domain/rooms.ts'
import { routeMessage, modelCommand } from '../../domain/routing.ts'
import { editableMessage, markEdited } from '../../domain/versions.ts'
import { HttpError } from '../../errors.ts'
import { resolveAttachments } from '../message-attachments.ts'
import type { RoomRouteDeps } from './context.ts'
import { MessageBodySchema, ParamsSchema } from './route-schemas.ts'

export function registerMessagePostRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest, port, clock, media, workspaces, mutation, routing, agents } = deps
  const { assertNotRewinding } = deps

  app.post('/api/rooms/:roomId/messages', mutation, async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.post'))
    assertNotRewinding(roomId)
    const body = MessageBodySchema.parse(request.body)
    // Edit and resend: checked before any side effect (a /assign task) and again inside the transaction below.
    const original = body.edits
      ? db.read((sqlite) => editableMessage(sqlite, roomId, body.edits!))
      : undefined
    if (body.jobId && original?.jobId && body.jobId !== original.jobId)
      throw new HttpError(
        400,
        'bad_request',
        'An edit stays in the job of the message it corrects.',
      )
    const jobId = body.jobId ?? original?.jobId
    // A closed or deleted job takes no new messages from the person (decision 121): reopen or undo first.
    if (jobId) db.read((sqlite) => assertJobOpen(sqlite, jobId))
    const to = [...new Set(body.to ?? original?.to ?? [])]
    const known = (await agents()).map((agent) => agent.id)
    if (to.some((id) => !known.includes(id)))
      throw new HttpError(400, 'bad_request', 'Couldn’t find that agent.')
    const attached = await resolveAttachments(body.attachments ?? [], media, workspaces, known)
    const mediaIds = attached.mediaIds
    const room = db.read((sqlite) => readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at))
    const stepIn = db.read((sqlite) => openExchangeIn(sqlite, roomId, jobId))
    const route = routeMessage(body.text, to, room, known, stepIn)
    let command: CommandResult | null = modelCommand(route.model)
    // `/model <alias>` names the model the alias stands for on each recipient (aliases belong to a profile).
    const typedModel = route.model ?? body.model
    const modelOf = new Map<string, { model: string; provider?: string }>()
    if (typedModel)
      for (const agentId of route.routedTo) {
        const alias = await resolveAlias(port, agentId, typedModel)
        modelOf.set(
          agentId,
          alias
            ? { model: alias.model, ...(alias.provider ? { provider: alias.provider } : {}) }
            : { model: typedModel },
        )
      }
    // A rewind may have started while agents and attachments were being prepared (awaits above): checked again before
    // any external side effect and, below, inside the transaction.
    assertNotRewinding(roomId)
    const id = randomUUID()
    if (route.parsed.command?.kind === 'assign') {
      const assigned = route.parsed.command
      const task = await port.createTask(
        {
          title: assigned.title,
          assignee: assigned.agentId,
          roomId,
          ...(assigned.body === null ? {} : { body: assigned.body }),
        },
        `assign:${id}`,
      )
      command = { kind: 'assign', taskId: task.id, taskKey: task.key }
    }
    if (route.parsed.command?.kind === 'routine') {
      const routine = route.parsed.command
      if (!known.includes(routine.agentId))
        throw new HttpError(400, 'bad_request', 'Couldn’t find that agent.')
      const created = await port.createRoutine(
        routine.agentId,
        {
          title: routine.prompt.replace(/\s+/g, ' ').trim().slice(0, 50),
          schedule: routine.schedule,
          prompt: routine.prompt,
        },
        `routine:${id}`,
      )
      command = { kind: 'routine', routineId: created.id }
    }
    let message: Message | undefined
    // Plan first goes to the lead when it is among the recipients, otherwise to the first recipient.
    const planner =
      body.planFirst && route.routedTo.length
        ? route.routedTo.includes(room.leadAgentId ?? '')
          ? room.leadAgentId
          : route.routedTo[0]
        : undefined
    // What each addressed agent is told about the attachments (and, for documents, saving them into its workspace).
    const notes = new Map<string, string>()
    const notices: string[] = []
    const day = new Date(clock()).toISOString().slice(0, 10)
    if (attached.documents.length || attached.references.length)
      for (const agentId of planner ? [planner] : route.routedTo) {
        const made = await attachmentNote({
          agentId,
          documents: attached.documents,
          references: attached.references,
          day,
          workspace: () => {
            if (!workspaces) throw new Error('workspaces are not available')
            return workspaces.open(agentId, (event) =>
              request.log.info({ agentId, workspace: event }, 'workspace write'),
            )
          },
        })
        notes.set(agentId, made.note)
        notices.push(...made.notices)
        for (const { mediaId, path } of made.saved) {
          const part = attached.parts.find((p) => p.kind === 'document' && p.mediaId === mediaId)
          if (part?.kind === 'document') part.saved = [...(part.saved ?? []), { agentId, path }]
        }
      }
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        assertNotRewinding(roomId)
        message = {
          id,
          roomId,
          author: { kind: 'you' },
          to,
          parts: [
            { kind: 'text', text: body.text },
            ...attached.parts,
            ...(body.refs ?? []).map((ref) => freezeRef(sqlite, ref.jobId, now)),
          ],
          createdAt: now,
          streaming: false,
          refs: [],
          ...(original ? { edits: original.id } : {}),
          // An edit stays in the job of the message it corrects.
          ...(jobId ? { jobId } : {}),
        }
        if (original) editableMessage(sqlite, roomId, original.id)
        // Inside the same transaction, so an item deleted since the check above fails the whole message.
        media?.retain(sqlite, mediaIds, now)
        const drafts = storeMessage(sqlite, message, now)
        message = messageFromRow(sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id))
        // In an exchanges room the agent the person addresses has the work (PLAN 11.1b).
        if (room.routing === 'exchanges' && message.jobId && route.routedTo[0])
          drafts.push(
            ...updateJob(
              sqlite,
              message.jobId,
              { holder: route.routedTo[0], state: 'working' },
              now,
            ),
          )
        if (original) drafts.push(...markEdited(sqlite, roomId, original, id, now))
        // Plan first admits only the planner; the others are named in its prompt and start from the plan.
        const team = route.routedTo.filter((agentId) => agentId !== planner)
        const teamNote = team.length
          ? `\n\nThe request was addressed to the team: ${route.routedTo.map((id) => `@${id}`).join(', ')}.`
          : ''
        for (const agentId of planner ? [planner] : route.routedTo)
          reserveMessageRun(
            sqlite,
            {
              parentMessageId: id,
              roomId,
              agentId,
              chainId: id,
              hop: 0,
              input:
                agentId === planner
                  ? route.input + (notes.get(agentId) ?? '') + teamNote + PLAN_FIRST_ADDENDUM
                  : route.input + (notes.get(agentId) ?? ''),
              agents: known,
              ...(agentId === planner ? { planFirst: true } : {}),
              ...(modelOf.has(agentId) ? modelOf.get(agentId) : {}),
            },
            now,
          )
        // Every human message that starts a turn (or creates a task with /assign) is a brief. It is created after
        // the turns are reserved so its first status already counts them.
        if (route.routedTo.length || command?.kind === 'assign')
          drafts.push(
            ...createBrief(
              sqlite,
              {
                id,
                roomId,
                text: body.text,
                tasks:
                  command?.kind === 'assign' ? [{ taskId: command.taskId, origin: 'assign' }] : [],
              },
              now,
            ),
          )
        return drafts
      },
    })
    await routing.dispatch()
    return { message, routedTo: route.routedTo, command, ...(notices.length ? { notices } : {}) }
  })
}

/** A job with an exchange still going (live, waiting on an agent or paused): a message into it steps in. */
function openExchangeIn(
  sqlite: DatabaseSync,
  roomId: string,
  jobId: string | null | undefined,
): boolean {
  const job = jobId ?? defaultJobId(sqlite, roomId)
  return Boolean(
    job &&
    sqlite
      .prepare(
        "SELECT 1 FROM exchanges WHERE job_id = ? AND state IN ('live', 'waiting_on_agent', 'paused_budget')",
      )
      .get(job),
  )
}
