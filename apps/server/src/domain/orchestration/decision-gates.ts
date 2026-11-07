import type { GateDecision, InquiryAnswer } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { touch, type Ctx } from './ctx.ts'
import { expectRevision, mustBeLive } from './decision-guards.ts'
import { addStored, cascadeBlocked, refuseAttempt, setStepStatus, utf8Bytes } from './ops.ts'
import { addCause, addHistory, attemptsOf, inquiriesOf, readGate, requireOrch } from './store.ts'

export function decideGate(ctx: Ctx, orchId: string, gateId: string, body: GateDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const gate = readGate(sqlite, orchId, gateId)
  if (!gate) throw new HttpError(404, 'not_found', 'Couldn’t find that gate.')
  if (gate.status !== 'open' || gate.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This gate was already decided or has changed.', {
      currentRevision: gate.revision,
    })
  const approve = body.decision === 'approve'
  sqlite
    .prepare(
      `UPDATE orc_gates SET status = ?, revision = revision + 1, note = ?, decided_at = ? WHERE orchestration_id = ? AND id = ?`,
    )
    .run(approve ? 'approved' : 'rejected', body.note ?? null, now, orchId, gateId)
  if (approve) setStepStatus(sqlite, orchId, gate.step_id, 'queued', null, now)
  else {
    setStepStatus(
      sqlite,
      orchId,
      gate.step_id,
      'rejected',
      body.note ? `rejected: ${body.note}` : 'rejected by the person',
      now,
    )
    sqlite
      .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
      .run(orchId, gate.step_id)
    // A coding step re-gated after "use the new settings" still has its suspended, proven-unsent attempt: rejecting the
    // gate closes it in the same transaction, so its reservation doesn't outlive the step (F1 #5).
    for (const held of attemptsOf(sqlite, orchId).filter(
      (candidate) =>
        candidate.step_id === gate.step_id && candidate.suspended && candidate.state === 'created',
    ))
      refuseAttempt(sqlite, held, 'not dispatched: the gate was rejected', now)
    addCause(sqlite, orchId, 'gate_rejected', gate.step_id, now, body.note ?? null)
    cascadeBlocked(sqlite, orchId, now)
  }
  addHistory(
    sqlite,
    orchId,
    approve ? 'gate_approved' : 'gate_rejected',
    { gateId, stepId: gate.step_id, payloadHash: gate.payload_hash },
    now,
  )
  touch(ctx, orchId)
}

export function answerInquiry(
  ctx: Ctx,
  orchId: string,
  inquiryId: string,
  body: InquiryAnswer,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const inquiry = inquiriesOf(sqlite, orchId).find((candidate) => candidate.id === inquiryId)
  if (!inquiry) throw new HttpError(404, 'not_found', 'Couldn’t find that question.')
  if (inquiry.status !== 'open' || inquiry.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This question was already answered or has changed.', {
      currentRevision: inquiry.revision,
    })
  sqlite
    .prepare(
      `UPDATE orc_inquiries SET status = 'answered', answer = ?, revision = revision + 1, answered_at = ? WHERE orchestration_id = ? AND id = ?`,
    )
    .run(body.answer, now, orchId, inquiryId)
  addStored(sqlite, orchId, utf8Bytes(body.answer))
  addCause(sqlite, orchId, 'inquiry_answered', inquiryId, now)
  addHistory(sqlite, orchId, 'inquiry_answered', { inquiryId }, now)
  touch(ctx, orchId)
}
