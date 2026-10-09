import type { StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { defaultNotificationPrefs, type NotificationPrefs } from './prefs.ts'
import { createNotificationRouter } from './router.ts'

const names: Record<string, string> = { lead: 'Lead', builder: 'Builder' }
function setup(overrides: Partial<NotificationPrefs> = {}, hidden = true) {
  const state = { prefs: { ...defaultNotificationPrefs(), enabled: true, ...overrides }, hidden }
  const router = createNotificationRouter({
    prefs: () => state.prefs,
    hidden: () => state.hidden,
    nameOf: (id) => names[id] ?? id,
  })
  return { state, router }
}
const ev = (type: string, data: unknown) =>
  ({ type, seq: 1, at: '2026-10-09T00:00:00.000Z', data }) as unknown as StreamEvent

const approval = (over: object = {}) => ({
  id: 'a1',
  agentId: 'lead',
  title: 'Run rm -rf build',
  actionable: true,
  status: 'pending',
  ...over,
})
const run = (over: object = {}) => ({
  id: 'r1',
  agentId: 'builder',
  origin: 'score',
  status: 'completed',
  ...over,
})
const message = (over: object = {}) => ({
  id: 'm1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [{ kind: 'text', text: 'The secret plan   is ready.' }],
  streaming: false,
  ...over,
})

test('nothing is delivered until this device opted in', () => {
  const { router } = setup({ enabled: false })
  expect(router.handle(ev('approval.requested', approval()))).toBeNull()
})

test('an approval waiting opens Now, and says nothing about the command without previews', () => {
  const { router, state } = setup()
  const payload = router.handle(ev('approval.requested', approval()))!
  expect(payload).toMatchObject({
    kind: 'approvals',
    title: 'Approval needed',
    url: '/now',
    tag: 'approval:a1',
  })
  expect(payload.body).toBe('Lead is waiting for your decision.')
  expect(JSON.stringify(payload)).not.toContain('rm -rf')
  state.prefs = { ...state.prefs, previews: true }
  expect(router.handle(ev('approval.requested', approval()))!.body).toBe('Lead: Run rm -rf build')
})

test('approvals already decided or not waiting on a person are ignored', () => {
  const { router } = setup()
  expect(router.handle(ev('approval.requested', approval({ actionable: false })))).toBeNull()
  expect(router.handle(ev('approval.requested', approval({ status: 'approved' })))).toBeNull()
})

test('a finished routine notifies once, and a failed one is a routine result, not an error', () => {
  const { router } = setup()
  expect(router.handle(ev('run.updated', run({ origin: 'cron', status: 'running' })))).toBeNull()
  const done = router.handle(ev('run.updated', run({ origin: 'cron' })))!
  expect(done).toMatchObject({ kind: 'routines', title: 'Routine finished', url: '/now/routines' })
  expect(router.handle(ev('run.updated', run({ origin: 'cron' })))).toBeNull()
  const failed = router.handle(
    ev('run.updated', run({ id: 'r2', origin: 'cron', status: 'failed' })),
  )!
  expect(failed).toMatchObject({ kind: 'routines', title: 'Routine failed' })
})

test('a failed run is an agent error and links to Watch; a completed ordinary run is silent', () => {
  const { router } = setup()
  expect(router.handle(ev('run.updated', run()))).toBeNull()
  expect(router.handle(ev('run.updated', run({ id: 'r3', status: 'failed' })))).toMatchObject({
    kind: 'errors',
    title: 'Builder hit an error',
    url: '/now/watch/builder',
  })
})

test('replies notify only while Score is in the background, with text only when previews are on', () => {
  const { router, state } = setup({}, false)
  expect(router.handle(ev('message.created', message()))).toBeNull()
  state.hidden = true
  const plain = router.handle(ev('message.created', message({ id: 'm2' })))!
  expect(plain).toMatchObject({ kind: 'replies', title: 'Lead replied', url: '/chat/general' })
  expect(plain.body).not.toContain('secret')
  state.prefs = { ...state.prefs, previews: true }
  expect(router.handle(ev('message.created', message({ id: 'm3' })))!.body).toBe(
    'The secret plan is ready.',
  )
  // Your own messages are not replies.
  expect(router.handle(ev('message.created', message({ author: { kind: 'you' } })))).toBeNull()
})

test('a streaming reply notifies when it completes, using the final text', () => {
  const { router, state } = setup({ previews: true })
  expect(router.handle(ev('message.created', message({ streaming: true, parts: [] })))).toBeNull()
  const done = router.handle(
    ev('message.completed', {
      messageId: 'm1',
      roomId: 'general',
      parts: [{ kind: 'text', text: 'All done.' }],
    }),
  )!
  expect(done.body).toBe('All done.')
  // A completion we never saw start (or already delivered) stays quiet.
  expect(router.handle(ev('message.completed', { messageId: 'm1', roomId: 'general' }))).toBeNull()
  state.prefs = { ...state.prefs, kinds: { ...state.prefs.kinds, replies: false } }
  router.handle(ev('message.created', message({ id: 'm9', streaming: true, parts: [] })))
  expect(router.handle(ev('message.completed', { messageId: 'm9', roomId: 'general' }))).toBeNull()
})

test('each kind can be turned off on its own', () => {
  const kinds = { approvals: false, routines: false, errors: false, replies: false }
  const { router } = setup({ kinds })
  expect(router.handle(ev('approval.requested', approval()))).toBeNull()
  expect(router.handle(ev('run.updated', run({ origin: 'cron' })))).toBeNull()
  expect(router.handle(ev('run.updated', run({ id: 'r5', status: 'failed' })))).toBeNull()
  expect(router.handle(ev('message.created', message()))).toBeNull()
})

const attempt = (over: object = {}) => ({
  id: 'kr_1',
  kind: 'kanban',
  agentId: 'builder',
  status: 'failed',
  taskId: 't1',
  task: { taskId: 't1', historyId: 'h1', current: true },
  ...over,
})

test('a failed attempt on the current board opens its task, never Watch', () => {
  const { router } = setup()
  const payload = router.handle(ev('attempt.updated', attempt()))!
  expect(payload).toMatchObject({ kind: 'errors', url: '/tasks/t1', tag: 'attempt:kr_1' })
  expect(payload.url).not.toContain('/watch/')
  // Once per attempt.
  expect(router.handle(ev('attempt.updated', attempt()))).toBeNull()
})

test('a failed attempt of an earlier copy of the board opens the attempt page', () => {
  const { router } = setup()
  const payload = router.handle(
    ev(
      'attempt.updated',
      attempt({
        id: 'kr_2',
        agentId: null,
        task: { taskId: 't9', historyId: 'h0', current: false },
      }),
    ),
  )!
  expect(payload.url).toBe('/attempts/kr_2')
  expect(payload.title).toBe('An attempt failed')
})

test('attempts that did not fail say nothing', () => {
  const { router } = setup()
  expect(router.handle(ev('attempt.updated', attempt({ status: 'completed' })))).toBeNull()
})
