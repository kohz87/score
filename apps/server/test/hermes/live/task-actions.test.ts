import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { taskAction, taskReader } from '../../../src/hermes/live/task-actions.ts'
import { createFixtureHome, insertTask } from '../../fixtures/hermes/sqlite-fixture.ts'

let home: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  home = createFixtureHome()
})
afterEach(() => {
  home.close()
})
function setup(status = 'blocked') {
  const { db } = home.build('kanban')
  insertTask(db, 't_test')
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, 't_test')
  const runner = vi.fn(async () => ({ exitCode: 0 }))
  const deps = {
    readTask: taskReader(home.home),
    withoutCredential: (_profile: string, text: string) =>
      text.replaceAll('exact-gateway-key', '[redacted]'),
    runner,
    hermesHome: home.home,
  }
  return { db, deps, runner }
}

test.each([
  [
    'comment',
    'Denied; keep password=example. exact-gateway-key',
    [
      'kanban',
      'comment',
      '--author',
      'score',
      '--',
      't_test',
      'Denied; keep password=example. [redacted]',
    ],
  ],
  ['unblock', 'Please retry', ['kanban', 'unblock', '--reason=Please retry', '--', 't_test']],
  ['unblock', undefined, ['kanban', 'unblock', '--reason=Unblocked in Score', '--', 't_test']],
  // User text that looks like an option stays data.
  ['unblock', '--help -p other', ['kanban', 'unblock', '--reason=--help -p other', '--', 't_test']],
  ['start', '--help', ['kanban', 'promote', '--', 't_test', '--help']],
  ['block', '--help', ['kanban', 'block', '--', 't_test', '--help']],
  ['request_review', '--help', ['kanban', 'request-review', '--summary=--help', '--', 't_test']],
  ['request_changes', '--help', ['kanban', 'request-changes', '--', 't_test', '--help']],
  ['complete', '--help', ['kanban', 'complete', '--result=--help', '--', 't_test']],
  ['archive', '--help', ['kanban', 'archive', '--', 't_test']],
] as const)('runs exact %s argv and rereads status', async (action, text, argv) => {
  const { db, deps, runner } = setup()
  runner.mockImplementation(async () => {
    if (action === 'unblock') db.prepare("UPDATE tasks SET status = 'ready'").run()
    return { exitCode: 0 }
  })
  await expect(
    taskAction({ taskId: 't_test', action, ...(text !== undefined ? { text } : {}) }, deps),
  ).resolves.toEqual({ hermesStatus: action === 'unblock' ? 'ready' : 'blocked' })
  expect(runner).toHaveBeenCalledExactlyOnceWith([...argv], {
    timeoutMs: 10000,
    hermesHome: home.home,
  })
})

test('unblock of non-blocked task conflicts without spawning', async () => {
  const { deps, runner } = setup('running')
  await expect(taskAction({ taskId: 't_test', action: 'unblock' }, deps)).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
    details: { hermesStatus: 'running' },
  })
  expect(runner).not.toHaveBeenCalled()
})

test('unknown task is 404 and malformed task IDs never reach CLI', async () => {
  const { deps, runner } = setup()
  await expect(
    taskAction({ taskId: 't_missing', action: 'comment', text: 'Deny' }, deps),
  ).rejects.toMatchObject({ status: 404 })
  await expect(taskAction({ taskId: '--help', action: 'unblock' }, deps)).rejects.toThrow()
  expect(runner).not.toHaveBeenCalled()
})

test.each(['ready', 'running', 'triage', 'archived'])(
  'nonzero unblock with state changed to %s is a conflict',
  async (status) => {
    const { db, deps, runner } = setup()
    runner.mockImplementation(async () => {
      db.prepare('UPDATE tasks SET status = ?').run(status)
      return { exitCode: 1 }
    })
    await expect(taskAction({ taskId: 't_test', action: 'unblock' }, deps)).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'Task state changed',
      details: { hermesStatus: status },
    })
  },
)

test.each(['comment', 'unblock'] as const)(
  'nonzero %s without transition is 409',
  async (action) => {
    const { deps, runner } = setup()
    runner.mockResolvedValue({ exitCode: 1 })
    await expect(
      taskAction({ taskId: 't_test', action, text: 'note' }, deps),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' })
  },
)
