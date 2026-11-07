import { OrchestrationCreatedSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { app, boot, createBody, detail, h, headers, post, status } from './http-helpers.ts'
import { attemptOf } from './harness.ts'

test('ownership: ordinary actions on the run room and brief are rejected while the run owns them; brief pause and resume are delegated', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const d = detail(id)
  const room = d.roomId
  const owned = (
    res: {
      statusCode: number
      json(): {
        error: {
          code: string
          details?: { orchestrationId: string; state: string; action: string }
        }
      }
    },
    action: string,
  ) => {
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('orchestration_owned')
    expect(res.json().error.details).toMatchObject({ orchestrationId: id, state: 'owned', action })
  }
  owned(await post(`/api/rooms/${room}/messages`, { text: 'hello @builder' }), 'message.post')
  // Renaming is an organising action (5.36): allowed while the run owns the room.
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room}`,
        headers,
        payload: { name: 'renamed' },
      })
    ).statusCode,
  ).toBe(200)
  owned(
    await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${room}`,
      headers,
      payload: { archived: true },
    }),
    'room.update',
  )
  // Harmless metadata is still the person's.
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${room}`,
        headers,
        payload: { pinned: true },
      })
    ).statusCode,
  ).toBe(200)
  owned(
    await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room}/messages/${d.briefId}`,
      headers,
    }),
    'message.delete',
  )
  owned(await post(`/api/rooms/${room}/summary`), 'summary.create')
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/retry`), 'message.retry')
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/stop`), 'message.stop')
  owned(
    await post(`/api/rooms/${room}/messages/${d.briefId}/rewind`, { turns: 1 }),
    'message.rewind',
  )
  owned(await post(`/api/rooms/${room}/messages/${d.briefId}/plan/start`), 'plan.start')
  // The run's pause and resume are its own controls.
  expect(
    (
      await post(`/api/orchestrations/${id}/pause`, {
        orchestrationRevision: detail(id).revision,
      })
    ).statusCode,
  ).toBe(200)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('person')
  expect(
    (await post(`/api/orchestrations/${id}/resume`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(200)
  expect(status(id)).toBe('running')
  // Team pause is a separate hold: it never pauses the run's brief, and Team Resume never clears the run's own pause.
  await post(`/api/orchestrations/${id}/pause`, { orchestrationRevision: detail(id).revision })
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  expect(h.rows('SELECT 1 FROM team_paused_briefs WHERE brief_id = ?', d.briefId)).toHaveLength(0)
  expect((await post('/api/team/resume')).statusCode).toBe(200)
  expect(status(id)).toBe('paused')
  expect(h.orch.summary(id).pauseReason).toBe('person')
})

test('ownership ends with the run: after a quiescent end the room is an ordinary room again', async () => {
  await boot()
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => status(id) === 'succeeded')
  expect(detail(id).ownership).toBe('released')
  const sent = await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'thanks' })
  expect(sent.statusCode).toBe(200)
  // A finished run has nothing to pause: its controls say so instead of acting.
  expect(
    (await post(`/api/orchestrations/${id}/pause`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(409)
})

test('draining keeps the guards: a finished run with an owed Stop still owns its room', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        await t.call('orch.finish', { outcome: 'success', summary: 'x' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const run = attemptOf(h, id, 'step', 's1')[0]!.runId!
  const { endRun } = await import('./harness.ts')
  await endRun(h, run, 'interrupted')
  await h.until(() => status(id) === 'finished_with_unresolved')
  expect(detail(id).ownership).toBe('draining')
  const blocked = await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'hi' })
  expect(blocked.statusCode).toBe(409)
  expect(blocked.json().error.details.state).toBe('draining')
  // Abandoning the step and the owed Stop's acknowledgement release the room.
  const s1 = attemptOf(h, id, 'step', 's1')[0]!
  const abandoned = await post(`/api/orchestrations/${id}/abandon`, {
    attemptIds: [s1.id],
    orchestrationRevision: detail(id).revision,
    acknowledge: true,
  })
  expect(abandoned.statusCode).toBe(200)
  await h.until(() => detail(id).ownership === 'released')
  await h.settle(300)
  expect(
    h
      .rows<{ detail: string }>(
        "SELECT detail FROM orc_history WHERE kind = 'ownership' ORDER BY id",
      )
      .map((row) => JSON.parse(row.detail).state),
  ).toEqual(['owned', 'draining', 'released'])
  expect(
    (await post(`/api/rooms/${detail(id).roomId}/messages`, { text: 'hi again' })).statusCode,
  ).toBe(200)
})

test('PLAN 5.36: a running run keeps its room (rename allowed, delete refused); once released the room is deleted with the run pruned and a tombstone left', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: '[fake:hold]' })
        await t.call('orch.finish', { outcome: 'success', summary: 'done' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).json(),
  ).orchestration.id
  await h.until(() => attemptOf(h, id, 'step', 's1').some((a) => a.state === 'running'))
  const room = detail(id).roomId
  const name = (h.rows('SELECT name FROM rooms WHERE id = ?', room)[0] as { name: string }).name
  const del = (confirm: string) =>
    app.inject({ method: 'DELETE', url: `/api/rooms/${room}`, headers, payload: { confirm } })
  const refused = await del(name)
  expect(refused.statusCode).toBe(409)
  expect(refused.json().error.code).toBe('orchestration_owned')
  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/rooms/${room}`,
    headers,
    payload: { name: 'renamed-run' },
  })
  expect(renamed.statusCode).toBe(200)
  const { endRun } = await import('./harness.ts')
  await endRun(h, attemptOf(h, id, 'step', 's1')[0]!.runId!, 'completed', 'long job done')
  await h.until(() => detail(id).ownership === 'released')
  expect((await del('wrong')).statusCode).toBe(400)
  expect((await del('#renamed-run')).statusCode).toBe(204)
  expect(h.rows('SELECT 1 FROM rooms WHERE id = ?', room)).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM orchestrations')).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM orc_attempts')).toHaveLength(0)
  expect(h.rows('SELECT 1 FROM briefs')).toHaveLength(0)
  expect(h.rows("SELECT 1 FROM orc_history WHERE kind = 'pruned'")).toHaveLength(1)
})
