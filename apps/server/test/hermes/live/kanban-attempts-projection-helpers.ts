import { afterEach, beforeEach } from 'vitest'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'

export let h: Harness

export function installKanbanAttemptsProjectionHooks() {
  beforeEach(() => {
    h = createHarness()
  })
  afterEach(async () => {
    await h.close()
  })
}

export async function started(setup?: () => void) {
  setup?.()
  const coordinator = h.make()
  await h.poll(coordinator, 3)
  return coordinator
}
