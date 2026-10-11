import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '@score/contract'
import {
  defaultChoice,
  startPreview,
  stepPreview,
  type PreviewDefinition,
  type PreviewState,
} from './preview-stepper.ts'

type N = WorkflowDefinition['nodes'][number]
const agent = (id: string): N => ({
  id,
  kind: 'agent',
  label: id,
  agentId: 'lead',
  instruction: 'x',
  retries: 0,
  onFailure: 'fail_run',
})
const gate = (id: string, onReject: 'route' | 'stop_run' = 'route'): N => ({
  id,
  kind: 'gate',
  label: id,
  question: 'ok?',
  onReject,
})
const branch = (id: string): N => ({
  id,
  kind: 'branch',
  label: id,
  subject: 'a',
  rules: [
    { id: 'pass', when: { kind: 'verdict', is: 'passed' } },
    { id: 'fix', when: { kind: 'verdict', is: 'changes_requested' } },
  ],
})
const join = (id: string): N => ({ id, kind: 'join', label: id, mode: 'all' })
const end = (id: string): N => ({ id, kind: 'end', label: id })
const edge = (from: string, port: string, to: string) => ({
  id: `${from}-${port}-${to}`,
  from,
  port,
  to,
})

function run(def: PreviewDefinition, answers: Record<string, string> = {}): PreviewState[] {
  const states = [startPreview(def)]
  for (
    let i = 0;
    i < 100 && states.at(-1)!.status !== 'done' && states.at(-1)!.status !== 'stopped';
    i++
  ) {
    const state = states.at(-1)!
    states.push(
      stepPreview(
        state,
        def,
        state.pause ? (answers[state.pause.nodeId] ?? defaultChoice(state.pause)) : undefined,
      ),
    )
  }
  return states
}

describe('preview stepper', () => {
  it('walks a line of steps in order and lights them one after another', () => {
    const def = {
      nodes: [agent('a'), agent('b'), end('z')],
      edges: [edge('a', 'ok', 'b'), edge('b', 'ok', 'z')],
    }
    const states = run(def)
    expect(states[0]!.nodes.get('a')).toBe('running')
    expect(states[0]!.nodes.get('b')).toBe('waiting')
    expect(states[1]!.nodes.get('a')).toBe('succeeded')
    expect(states[1]!.nodes.get('b')).toBe('running')
    expect(states[1]!.effects.map((e) => e.kind)).toEqual(['dot', 'pulse'])
    const last = states.at(-1)!
    expect(last.status).toBe('done')
    expect([...last.nodes.values()]).toEqual(['succeeded', 'succeeded', 'succeeded'])
  })

  it('pauses at a gate and follows the answer', () => {
    const def = {
      nodes: [agent('a'), gate('g'), agent('yes'), agent('no'), end('z')],
      edges: [
        edge('a', 'ok', 'g'),
        edge('g', 'ok', 'yes'),
        edge('g', 'rejected', 'no'),
        edge('yes', 'ok', 'z'),
        edge('no', 'ok', 'z'),
      ],
    }
    const paused = run(def).find((s) => s.status === 'paused')!
    expect(paused.pause).toMatchObject({ kind: 'gate', nodeId: 'g' })
    expect(paused.nodes.get('g')).toBe('gate')
    // Without an answer nothing moves.
    expect(stepPreview(paused, def).nodes.get('g')).toBe('gate')
    const approved = run(def, { g: 'ok' }).at(-1)!
    expect(approved.nodes.get('yes')).toBe('succeeded')
    expect(approved.nodes.get('no')).toBe('skipped')
    const rejected = run(def, { g: 'rejected' }).at(-1)!
    expect(rejected.nodes.get('g')).toBe('rejected')
    expect(rejected.nodes.get('no')).toBe('succeeded')
    expect(rejected.nodes.get('yes')).toBe('skipped')
    expect(rejected.status).toBe('done')
  })

  it('stops the run when a gate that stops on rejection is rejected', () => {
    const def = { nodes: [gate('g', 'stop_run'), agent('a')], edges: [edge('g', 'ok', 'a')] }
    const last = run(def, { g: 'rejected' }).at(-1)!
    expect(last.status).toBe('stopped')
    expect(last.nodes.get('a')).toBe('cancelled')
  })

  it('asks a branch which way to go, first rule by default, and skips the other paths', () => {
    const def = {
      nodes: [agent('a'), branch('b'), agent('p'), agent('f'), agent('d'), end('z')],
      edges: [
        edge('a', 'ok', 'b'),
        edge('b', 'pass', 'p'),
        edge('b', 'fix', 'f'),
        edge('b', 'default', 'd'),
        edge('p', 'ok', 'z'),
        edge('f', 'ok', 'z'),
        edge('d', 'ok', 'z'),
      ],
    }
    const asking = run(def).find((s) => s.status === 'paused')!
    expect(asking.pause?.kind === 'branch' && asking.pause.options.map((o) => o.port)).toEqual([
      'pass',
      'fix',
      'default',
    ])
    expect(defaultChoice(asking.pause!)).toBe('pass')
    const first = run(def).at(-1)!
    expect(first.nodes.get('p')).toBe('succeeded')
    expect(first.nodes.get('f')).toBe('skipped')
    expect(first.nodes.get('d')).toBe('skipped')
    const other = run(def, { b: 'default' }).at(-1)!
    expect(other.nodes.get('d')).toBe('succeeded')
    expect(other.nodes.get('p')).toBe('skipped')
    expect(other.edges.get('b-pass-p')).toBe('skipped')
    expect(other.edges.get('b-default-d')).toBe('taken')
    expect(other.nodes.get('z')).toBe('succeeded')
  })

  it('makes a join wait for every path into it', () => {
    const def = {
      nodes: [agent('a'), agent('b1'), agent('b2'), agent('slow'), join('j'), end('z')],
      edges: [
        edge('a', 'ok', 'b1'),
        edge('a', 'ok', 'b2'),
        edge('b1', 'ok', 'j'),
        edge('b2', 'ok', 'slow'),
        edge('slow', 'ok', 'j'),
        edge('j', 'ok', 'z'),
      ],
    }
    const states = run(def)
    const b1Done = states.find((s) => s.nodes.get('b1') === 'succeeded')!
    expect(b1Done.nodes.get('j')).toBe('waiting')
    const joined = states.find((s) => s.nodes.get('j') === 'running')!
    expect(joined.nodes.get('slow')).toBe('succeeded')
    expect(states.at(-1)!.nodes.get('z')).toBe('succeeded')
  })

  it('passes over a join when every path into it was skipped', () => {
    const def = {
      nodes: [agent('a'), branch('b'), agent('p'), agent('f'), join('j'), end('z')],
      edges: [
        edge('a', 'ok', 'b'),
        edge('b', 'pass', 'p'),
        edge('b', 'fix', 'f'),
        edge('b', 'default', 'z'),
        edge('p', 'ok', 'j'),
        edge('f', 'ok', 'j'),
        edge('j', 'ok', 'z'),
      ],
    }
    const last = run(def, { b: 'default' }).at(-1)!
    expect(last.nodes.get('j')).toBe('skipped')
    expect(last.nodes.get('z')).toBe('succeeded')
    expect(last.status).toBe('done')
  })

  it('never follows the "when it fails" path of a step that succeeded', () => {
    const def = {
      nodes: [agent('a'), agent('repair'), end('z')],
      edges: [edge('a', 'ok', 'z'), edge('a', 'failed', 'repair')],
    }
    const last = run(def).at(-1)!
    expect(last.nodes.get('repair')).toBe('skipped')
    expect(last.edges.get('a-failed-repair')).toBe('skipped')
  })

  it('is done at once when a stopped or finished preview is stepped again', () => {
    const def = { nodes: [end('z')], edges: [] }
    const done = run(def).at(-1)!
    expect(stepPreview(done, def)).toMatchObject({ status: 'done', effects: [] })
  })
})
