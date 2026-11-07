import { MessageSchema } from '@score/contract'
import { expect, test, vi } from 'vitest'
import {
  addAgent,
  coding,
  finished,
  makeRoom,
  replies,
  request,
  runs,
  say,
  setupCodingRuntime,
} from './coding-runtime-helpers.ts'

setupCodingRuntime()

test('Reports: Claude Code spend is estimated, Codex without a cost is unknown and left out of the total', async () => {
  await addAgent()
  await addAgent({ id: 'cx', name: 'Cx', runtime: 'codex', acknowledgeReads: true })
  await makeRoom()
  await say('@coder one')
  await finished(1)
  await say('@cx two')
  await finished(2)
  const report = (await request('GET', '/api/reports?range=7d')).json()
  const byAgent = Object.fromEntries(
    report.byAgent.map((row: { agentId: string }) => [row.agentId, row]),
  )
  expect(byAgent.coder).toMatchObject({
    spendUsd: 0.01,
    spendBasis: 'estimated',
    runtime: 'claude-code',
    runs: 1,
  })
  expect(byAgent.cx).toMatchObject({
    spendUsd: null,
    spendBasis: 'unknown',
    runtime: 'codex',
    runs: 1,
  })
  expect(report.totals.spendEstimated).toBe(true)
  expect(report.totals.spendExcluded).toEqual(['cx'])
})

test('Now sees the coding agent’s runs with their runtime', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder go')
  await finished()
  const now = (await request('GET', '/api/now')).json()
  expect(JSON.stringify(now)).toContain('"coder"')
  expect(JSON.stringify(now)).toContain('"runtime":"claude-code"')
})

test('removing an agent hides it; a running turn must be stopped first', async () => {
  await addAgent()
  await makeRoom()
  await say('@coder [fixture:slow] hold')
  await vi.waitFor(() => expect(runs()[0]?.status).toBe('running'), { timeout: 10_000 })
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(409)
  await coding.close()
  await finished()
  expect((await request('DELETE', '/api/coding-agents/coder')).statusCode).toBe(204)
  expect(
    ((await request('GET', '/api/agents')).json().items as { id: string }[]).some(
      (item) => item.id === 'coder',
    ),
  ).toBe(false)
  expect(MessageSchema.safeParse(replies()[0]).success).toBe(true)
  const report = (await request('GET', '/api/reports?range=7d')).json()
  expect(report.byAgent.some((row: { agentId: string }) => row.agentId === 'coder')).toBe(false)
})
