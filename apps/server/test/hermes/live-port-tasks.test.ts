import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { LivePortOptions } from '../../src/hermes/live/live-port.ts'
import { buildFixture, insertTask } from '../fixtures/hermes/sqlite-fixture.ts'
import { createLivePort, installLivePortHooks, type LivePortEnv } from './live-port-helpers.ts'

let env: LivePortEnv
let port: ReturnType<typeof createLivePort> | undefined

installLivePortHooks(
  (state) => {
    env = state.env
    port = state.port
  },
  () => ({ env, port }),
)

function create(runner?: LivePortOptions['runner'], frozen?: () => string | null) {
  return (port = createLivePort(env, runner, frozen))
}

test.each(['builder', 'reviewer'])(
  'live task actions redact only a known exact %s gateway key',
  async (assignee) => {
    const runner = vi.fn<NonNullable<LivePortOptions['runner']>>(async () => ({ exitCode: 0 }))
    const live = create(runner)
    const fixture = buildFixture(join(env.home, 'upstream-fixture', 'kanban.db'), 'kanban')
    try {
      insertTask(fixture, 't_test')
      fixture.prepare("UPDATE tasks SET status = 'blocked', assignee = ?").run(assignee)
      await live.start(env.ingest)
      const key = env.fake.keys.get('builder')!
      const text =
        assignee === 'builder' ? `Deny ${key}; password=example` : 'Deny; password=example'
      expect(await live.taskAction({ taskId: 't_test', action: 'comment', text })).toEqual({
        hermesStatus: 'blocked',
      })
      expect(runner).toHaveBeenCalledWith(
        [
          'kanban',
          'comment',
          '--author',
          'score',
          '--',
          't_test',
          assignee === 'builder' ? 'Deny [redacted]; password=example' : text,
        ],
        { timeoutMs: 10000, hermesHome: join(env.home, 'upstream-fixture') },
      )
    } finally {
      fixture.close()
    }
  },
)
