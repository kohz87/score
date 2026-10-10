import type { OrchEvent, StepView } from '@score/contract'
import { describe, expect, test } from 'vitest'
import {
  buildGraph,
  EffectQueue,
  eventEffect,
  filterLog,
  freshEvents,
  LEAD_NODE,
  replayAt,
  replayDelayMs,
  stepVisual,
} from './orch-model.ts'

let n = 0
const ev = (patch: Partial<OrchEvent> & Pick<OrchEvent, 'kind'>): OrchEvent => ({
  id: `e${++n}`,
  at: new Date(Date.UTC(2026, 9, 10, 10, 0, 0) + n * 1000).toISOString(),
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  summary: patch.kind,
  ...patch,
})
const step = (id: string, patch: Partial<StepView> = {}): StepView => ({
  id,
  agentId: 'builder',
  instruction: 'x',
  after: [],
  replaces: null,
  status: 'queued',
  disposition: null,
  estimateUsd: 0.5,
  result: null,
  resultRevision: 0,
  gateId: null,
  attemptId: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  ...patch,
})

describe('state to visuals', () => {
  test('maps every step status to a distinct look, attempts decide starting vs running', () => {
    expect(stepVisual({ status: 'pending_gate' })).toBe('gate')
    expect(stepVisual({ status: 'queued' })).toBe('queued')
    expect(stepVisual({ status: 'admitted' }, { state: 'send_started', abandonedAt: null })).toBe(
      'admitting',
    )
    expect(stepVisual({ status: 'admitted' }, { state: 'running', abandonedAt: null })).toBe(
      'running',
    )
    expect(stepVisual({ status: 'unknown' }, { state: 'unknown', abandonedAt: null })).toBe(
      'unknown',
    )
    expect(
      stepVisual(
        { status: 'unknown' },
        { state: 'abandoned', abandonedAt: '2026-10-10T10:00:00Z' },
      ),
    ).toBe('abandoned')
    expect(stepVisual({ status: 'succeeded' })).toBe('succeeded')
    expect(stepVisual({ status: 'failed' })).toBe('failed')
    expect(stepVisual({ status: 'cancelled' })).toBe('cancelled')
  })

  test('the graph has a lead, one node per step, after edges and dashed replaces lineage', () => {
    const graph = buildGraph({
      leadAgentId: 'lead',
      stepsList: [step('s1'), step('s2', { after: ['s1'] }), step('s3', { replaces: 's1' })],
    })
    expect(graph.nodes.map((node) => node.id)).toEqual([LEAD_NODE, 's1', 's2', 's3'])
    expect(graph.edges.map((edge) => `${edge.kind}:${edge.from}>${edge.to}`)).toEqual([
      'assign:lead>s1',
      'after:s1>s2',
      'replaces:s1>s3',
    ])
  })
})

describe('events to effects', () => {
  const known = new Set(['s1'])
  test('an accepted assignment sends a dot lead to step, a result sends one back', () => {
    expect(
      eventEffect(
        ev({ kind: 'command', tool: 'orch.assign', verdict: 'accepted', stepId: 's1' }),
        known,
      ),
    ).toMatchObject({ kind: 'dot', from: LEAD_NODE, to: 's1', tone: 'ok' })
    expect(
      eventEffect(ev({ kind: 'step_result', stepId: 's1', verdict: 'failed' }), known),
    ).toMatchObject({ kind: 'dot', from: 's1', to: LEAD_NODE, tone: 'fail' })
  })

  test('a refused call lights the lead as refused and never moves a dot', () => {
    const effect = eventEffect(
      ev({ kind: 'command', tool: 'orch.assign', verdict: 'refused', code: 'step_limit' }),
      known,
    )
    expect(effect).toMatchObject({ kind: 'pulse', to: LEAD_NODE, tone: 'refused' })
  })

  test('nothing is invented: events about unknown steps or without a visual give no effect', () => {
    expect(
      eventEffect(ev({ kind: 'step_result', stepId: 'zz', verdict: 'succeeded' }), known),
    ).toBeNull()
    expect(eventEffect(ev({ kind: 'run_started' }), known)).toBeNull()
    expect(eventEffect(ev({ kind: 'lead_done' }), known)).toBeNull()
  })

  test('only events not seen before are new', () => {
    const a = ev({ kind: 'run_started' })
    const b = ev({ kind: 'lead_wake' })
    expect(freshEvents(new Set([a.id]), [a, b])).toEqual([b])
  })
})

describe('the effect queue', () => {
  const fx = (id: string) => ({
    eventId: id,
    kind: 'dot' as const,
    from: 'lead',
    to: 's1',
    tone: 'ok' as const,
  })
  test('keeps order and starts at most one effect per 300 ms', () => {
    const queue = new EffectQueue(300)
    queue.push([fx('a'), fx('b'), fx('c')])
    expect(queue.take(1000)?.eventId).toBe('a')
    expect(queue.take(1100)).toBeNull()
    expect(queue.wait(1100)).toBe(200)
    expect(queue.take(1300)?.eventId).toBe('b')
    expect(queue.take(1299)).toBeNull()
    expect(queue.take(1600)?.eventId).toBe('c')
    expect(queue.take(5000)).toBeNull()
  })

  test('a burst beyond its bound drops the oldest and counts them instead of rushing', () => {
    const queue = new EffectQueue(300, 3)
    queue.push([fx('1'), fx('2'), fx('3'), fx('4'), fx('5')])
    expect(queue.dropped).toBe(2)
    expect(queue.take(0)?.eventId).toBe('3')
  })
})

describe('log filtering', () => {
  const events = [
    ev({ kind: 'run_started' }),
    ev({ kind: 'lead_wake' }),
    ev({ kind: 'command', tool: 'orch.assign', verdict: 'accepted', stepId: 's1' }),
    ev({ kind: 'step_admitted', stepId: 's1' }),
    ev({ kind: 'step_admitted', stepId: 's2' }),
    ev({ kind: 'step_result', stepId: 's1', verdict: 'succeeded' }),
  ]
  test('a step node shows only that step, the lead shows its turns and calls, null shows all', () => {
    expect(filterLog(events, { node: null })).toHaveLength(6)
    expect(filterLog(events, { node: 's1' }).map((e) => e.kind)).toEqual([
      'command',
      'step_admitted',
      'step_result',
    ])
    expect(filterLog(events, { node: 's2' })).toHaveLength(1)
    expect(filterLog(events, { node: LEAD_NODE }).map((e) => e.kind)).toEqual([
      'run_started',
      'lead_wake',
      'command',
    ])
  })
})

describe('replay state at a time', () => {
  const events = [
    ev({ kind: 'run_started' }),
    ev({ kind: 'lead_wake' }),
    ev({ kind: 'command', tool: 'orch.assign', verdict: 'accepted', stepId: 's1' }),
    ev({ kind: 'gate_opened', stepId: 's1' }),
    ev({ kind: 'gate_decided', stepId: 's1', verdict: 'approved' }),
    ev({ kind: 'step_admitted', stepId: 's1' }),
    ev({ kind: 'step_result', stepId: 's1', verdict: 'succeeded' }),
    ev({ kind: 'lead_done' }),
    ev({ kind: 'control', verdict: 'ended', summary: 'Run ended: succeeded' }),
  ]
  test('steps appear when assigned and follow gate, admission and result', () => {
    expect(replayAt(events, 0).steps.size).toBe(0)
    expect(replayAt(events, 3).steps.get('s1')).toBe('queued')
    expect(replayAt(events, 4).steps.get('s1')).toBe('gate')
    expect(replayAt(events, 5).steps.get('s1')).toBe('queued')
    expect(replayAt(events, 6).steps.get('s1')).toBe('running')
    expect(replayAt(events, 7).steps.get('s1')).toBe('succeeded')
    expect(replayAt(events, 2).lead).toBe('working')
    expect(replayAt(events, 8).lead).toBe('idle')
    const end = replayAt(events, 99)
    expect(end.lead).toBe('ended')
    expect(end.shown).toBe(events.length)
  })

  test('a rejection and a stop show up, queued work is not started after Stop', () => {
    const more = [
      ev({ kind: 'command', tool: 'orch.assign', verdict: 'accepted', stepId: 's1' }),
      ev({ kind: 'command', tool: 'orch.assign', verdict: 'accepted', stepId: 's2' }),
      ev({ kind: 'gate_decided', stepId: 's1', verdict: 'rejected' }),
      ev({ kind: 'control', verdict: 'stop_requested' }),
    ]
    const state = replayAt(more, 4)
    expect(state.steps.get('s1')).toBe('rejected')
    expect(state.steps.get('s2')).toBe('not_started')
  })

  test('replay waits the recorded gap, kept readable, divided by the speed', () => {
    const a = ev({ kind: 'run_started', at: '2026-10-10T10:00:00.000Z' })
    const b = ev({ kind: 'lead_wake', at: '2026-10-10T10:00:00.100Z' })
    const c = ev({ kind: 'lead_done', at: '2026-10-10T11:00:00.000Z' })
    expect(replayDelayMs([a, b, c], 0, 1)).toBe(300)
    expect(replayDelayMs([a, b, c], 1, 1)).toBe(3000)
    expect(replayDelayMs([a, b, c], 1, 4)).toBe(750)
    expect(replayDelayMs([a, b, c], 1, 16)).toBe(188)
    expect(replayDelayMs([a, b, c], 2, 1)).toBe(0)
  })
})
