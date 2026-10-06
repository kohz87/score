import { SystemStatusSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'

test('the live stub reports unavailable and rejects every operation with the specified 503', async () => {
  const port = createHermesPort(loadConfig({ SCORE_MODE: 'live' }))
  expect(port.mode).toBe('live')
  expect(SystemStatusSchema.parse({ mode: port.mode, ...port.status() })).toMatchObject({
    hermes: { reachable: false, apiServer: false },
    degraded: ['Live Hermes adapter is not implemented yet'],
  })
  for (const operation of [
    () => port.start({ submit: async () => ({ status: 'duplicate' }) }),
    () => port.stop(),
    () => port.listAgents(),
    () => port.startRun({ agentId: 'lead', input: 'Hello', turnId: 'turn-one' }),
    () => port.stopRun({ agentId: 'lead', runId: 'run-one' }),
    () => port.deliverDecision({ approvalId: 'approval-one', choice: 'once' }),
  ]) {
    await expect(operation()).rejects.toMatchObject({
      status: 503,
      code: 'hermes_unavailable',
      message: 'Live Hermes adapter is not implemented yet',
    })
  }
})
