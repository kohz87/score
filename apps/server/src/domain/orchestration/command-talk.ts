import { redact } from '../../redact.ts'
import { storeMessage } from '../rooms.ts'
import { ok, quotaRefusal, refuse, type Handler } from './command-support.ts'
import { addStored, utf8Bytes } from './ops.ts'
import { inquiriesOf } from './store.ts'

export const askCommand: Handler = (ctx, o, attempt, args) => {
  const { sqlite, now } = ctx
  const question = redact(args.question as string)
  const open = inquiriesOf(sqlite, o.id).filter((inquiry) => inquiry.status === 'open')
  if (open.length >= 3)
    return refuse('too_many_questions', 'Three questions are already waiting for the person')
  const quota = quotaRefusal(o, utf8Bytes(question) + 128)
  if (quota) return quota
  const id = `q${inquiriesOf(sqlite, o.id).length + 1}`
  sqlite
    .prepare(
      `INSERT INTO orc_inquiries (orchestration_id, id, attempt_id, question, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`,
    )
    .run(o.id, id, attempt.id, question, now)
  addStored(sqlite, o.id, utf8Bytes(question) + 128)
  return ok({ inquiryId: id })
}

export const noteCommand: Handler = (ctx, o, attempt, args) => {
  const text = redact(args.text as string)
  const quota = quotaRefusal(o, utf8Bytes(text) + 256)
  if (quota) return quota
  const id = `orc-note:${attempt.id}:${args.commandId}`
  ctx.events.push(
    ...storeMessage(
      ctx.sqlite,
      {
        id,
        roomId: o.room_id,
        author: { kind: 'agent', agentId: attempt.agent_id },
        to: [],
        parts: [{ kind: 'text', text, via: 'mcp' }],
        createdAt: ctx.now,
        streaming: false,
        refs: [],
      },
      ctx.now,
    ),
  )
  addStored(ctx.sqlite, o.id, utf8Bytes(text) + 256)
  return ok({ messageId: id })
}
