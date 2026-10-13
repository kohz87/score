import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { FAKE_CLI } from '../runtimes/coding-fixtures.ts'
import { loadConfig } from '../../src/config.ts'
import {
  assertOrchestrationWorkers,
  type CodingWorkerFacts,
} from '../../src/domain/orchestration/supported-agents.ts'
import { withCodingAgents } from '../../src/runtimes/coding/port.ts'
import type { CodingRuntime } from '../../src/runtimes/coding/service.ts'
import { startServer } from '../../src/start-server.ts'

// 7.7b-1 #1: one composite port, and the orchestration guard that lets Claude Code and Codex take steps.

const team = [
  { id: 'lead', runtime: 'hermes' as const },
  { id: 'builder', runtime: 'hermes' as const },
  { id: 'cc', runtime: 'claude-code' as const },
  { id: 'cx', runtime: 'codex' as const },
  { id: 'ag', runtime: 'antigravity' as const },
  { id: 'wide', runtime: 'codex' as const },
]
const facts = (unitHost: boolean): CodingWorkerFacts => ({
  unitHost: () => unitHost,
  agent: (id) =>
    ({
      cc: { runtime: 'claude-code', permission: 'workspace-write' },
      cx: { runtime: 'codex', permission: 'read-only' },
      ag: { runtime: 'antigravity', permission: 'workspace-write' },
      wide: { runtime: 'codex', permission: 'full' },
    })[id],
})
const codeOf = (fn: () => void): string | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

test('the orchestration guard: Claude Code and Codex may take steps, nothing else non-Hermes may', () => {
  expect(
    codeOf(() => assertOrchestrationWorkers('lead', ['builder', 'cc', 'cx'], team, facts(true))),
  ).toBe(undefined)
  // A coding agent never leads.
  expect(codeOf(() => assertOrchestrationWorkers('cc', ['builder'], team, facts(true)))).toBe(
    'unsupported_agent',
  )
  // Antigravity and `full` are refused, whatever the host.
  expect(codeOf(() => assertOrchestrationWorkers('lead', ['ag'], team, facts(true)))).toBe(
    'unsupported_agent',
  )
  expect(codeOf(() => assertOrchestrationWorkers('lead', ['wide'], team, facts(true)))).toBe(
    'unsupported_agent',
  )
  // No coding runtime wired: every coding agent is refused.
  expect(codeOf(() => assertOrchestrationWorkers('lead', ['cc'], team, undefined))).toBe(
    'unsupported_agent',
  )
  // A host without units refuses with its own code.
  expect(codeOf(() => assertOrchestrationWorkers('lead', ['cc'], team, facts(false)))).toBe(
    'coding_workers_need_units',
  )
  // Hermes-only teams never need the facts.
  expect(codeOf(() => assertOrchestrationWorkers('lead', ['builder'], team, undefined))).toBe(
    undefined,
  )
})

test('the composite port is built once: wrapping it again returns the same object', () => {
  const runtime = { isCodingAgent: () => false } as unknown as CodingRuntime
  const raw = { mode: 'fake' } as never
  const composite = withCodingAgents(raw, runtime)
  expect(withCodingAgents(composite, runtime)).toBe(composite)
  expect(withCodingAgents(raw, runtime)).not.toBe(raw)
})

test('start-server hands the executor the composite port: it sees coding agents and refuses them on a host without units', async () => {
  vi.stubEnv('SCORE_CODING_FAKE_CLI', FAKE_CLI)
  const home = mkdtempSync(join(tmpdir(), 'score-guard-'))
  const workspace = join(home, 'ws')
  mkdirSync(workspace)
  const server = await startServer(
    loadConfig({
      SCORE_HOME: join(home, 'h'),
      SCORE_MODE: 'fake',
      SCORE_FAKE_SPEED: '100',
      SCORE_FAKE_LOOP: 'false',
    }),
    { logger: false, listen: async (app) => void (await app.ready()) },
  )
  try {
    const paired = await server.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: server.pairingToken },
    })
    const headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const added = await server.app.inject({
      method: 'POST',
      url: '/api/coding-agents',
      headers,
      payload: {
        id: 'coder',
        name: 'Coder',
        runtime: 'codex',
        workspace,
        acknowledgeReads: true,
        style: { color: '#19C39A', shape: 'hexagon' },
      },
    })
    expect(added.statusCode, added.body).toBe(201)
    // Without handing the agents in, the executor asks its own port: only the composite knows `coder`.
    await expect(server.orchestrator.preflight('lead', ['coder'])).rejects.toMatchObject({
      status: 422,
      code: 'coding_workers_need_units',
    })
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/orchestrations',
      headers,
      payload: {
        goal: 'Write the release notes',
        leadAgentId: 'lead',
        allowedAgents: ['coder'],
        gatePolicy: 'none',
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
      },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('coding_workers_need_units')
  } finally {
    await server.close()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}, 40_000)
