import { expect, test, vi } from 'vitest'
import { claudeDriver } from '../../src/runtimes/coding/claude.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import {
  addAgent,
  calls,
  coding,
  makeRoom,
  runs,
  setupCodingRuntime,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

const NO_BACKGROUND = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'

test('Claude Code runs with background sub-agents off: one run has one result (SA)', () => {
  expect(claudeDriver.runEnv).toEqual({ [NO_BACKGROUND]: '1' })
  expect(codexDriver.runEnv).toBeUndefined()
})

test('the variable reaches the launched CLI', async () => {
  await addAgent()
  await makeRoom()
  await coding.startRun({ agentId: 'coder', input: 'go', turnId: 't-env' })
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('completed'), { timeout: 20_000 })
  // A version probe has an empty prompt; the launched turn has its prompt.
  const turn = calls().find((call) => call.prompt) as unknown as { env: string[] }
  expect(turn.env).toContain(NO_BACKGROUND)
})
