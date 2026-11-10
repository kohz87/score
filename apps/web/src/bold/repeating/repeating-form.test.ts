import type { RepeatingJob, Room } from '@score/contract'
import { expect, test } from 'vitest'
import { blankForm, createBody, formOf, formProblem, patchBody } from './repeating-form.ts'
import { job } from './repeating-helpers.tsx'

const direct = (agentId: string) =>
  ({
    id: `direct-${agentId}`,
    kind: 'direct',
    role: 'direct',
    members: [agentId],
  }) as unknown as Room
const directs = [direct('builder'), direct('reviewer')]
const made = (extra: Record<string, unknown> = {}) =>
  job('r1', 'builder', {
    deliverTo: { roomId: 'direct-builder', roomName: 'builder' },
    ...extra,
  }) as unknown as RepeatingJob

test('a form opened from a job and changed in nothing sends nothing', () => {
  const form = formOf(made(), [], directs)
  expect(form.deliver).toBe('direct')
  expect(patchBody(form, { ...form }, 'direct-builder', 'direct-builder')).toEqual({})
})

test('only the changed fields go, and the zone only with a changed schedule', () => {
  const before = formOf(made(), [], directs)
  const body = patchBody(
    before,
    { ...before, title: ' New name ', kind: 'weekdays', time: '09:30' },
    'direct-builder',
    'direct-builder',
  )
  expect(Object.keys(body).sort()).toEqual(['schedule', 'timezone', 'title'])
  expect(body.schedule).toBe('30 9 * * 1-5')
  const alone = patchBody(before, { ...before, prompt: 'Else' }, 'direct-builder', 'direct-builder')
  expect(alone).toEqual({ prompt: 'Else' })
})

test('pin, unpin and results', () => {
  const plain = formOf(made(), [], directs)
  const pin = { model: 'deep', provider: null }
  expect(
    patchBody(
      plain,
      { ...plain, modelMode: 'pinned', pinned: pin },
      'direct-builder',
      'direct-builder',
    ),
  ).toEqual({ model: pin })
  const pinned = formOf(made({ model: 'deep' }), [], directs)
  expect(
    patchBody(pinned, { ...pinned, modelMode: 'own' }, 'direct-builder', 'direct-builder'),
  ).toEqual({ model: null })
  expect(
    patchBody(plain, { ...plain, deliver: 'none' }, 'direct-builder', 'direct-builder'),
  ).toEqual({ deliverTo: null })
  expect(
    patchBody(
      plain,
      { ...plain, deliver: 'chat', roomId: 'room-a' },
      'direct-builder',
      'direct-builder',
    ),
  ).toEqual({ deliverTo: 'room-a' })
  // Moved to reviewer, results still "its direct chat": that is reviewer's chat now.
  expect(
    patchBody(plain, { ...plain, agentId: 'reviewer' }, 'direct-builder', 'direct-reviewer'),
  ).toEqual({ deliverTo: 'direct-reviewer' })
})

test('a custom schedule as typed, and problems in plain words', () => {
  const form = { ...blankForm('builder'), title: 'T', prompt: 'P' }
  expect(formProblem({ ...form, kind: 'custom', custom: 'every 2h' }, 'd')).toBeNull()
  expect(formProblem({ ...form, kind: 'custom', custom: 'whenever' }, 'd')).toMatch(
    /isn’t a schedule/,
  )
  expect(formProblem({ ...form, title: ' ' }, 'd')).toMatch(/title/)
  expect(formProblem({ ...form, time: '8am' }, 'd')).toMatch(/HH:MM/)
  expect(formProblem({ ...form, modelMode: 'pinned' }, 'd')).toMatch(/model/)
  expect(formProblem(form, null)).toMatch(/no direct chat/)
  const body = createBody(
    { ...form, modelMode: 'pinned', pinned: { model: 'deep', provider: null }, deliver: 'none' },
    'd',
  )
  expect(body).toMatchObject({
    title: 'T',
    prompt: 'P',
    schedule: '0 8 * * *',
    model: { model: 'deep', provider: null },
  })
  expect(body.deliverTo).toBeUndefined()
  expect(body.timezone).toBeTruthy()
})
