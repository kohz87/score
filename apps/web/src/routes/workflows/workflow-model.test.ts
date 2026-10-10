import { expect, test } from 'vitest'
import {
  addNode,
  addRule,
  ancestorsOf,
  connect,
  disconnect,
  idFromLabel,
  nextNodeId,
  outlineOf,
  portsOf,
  removeNode,
  removeRule,
  renameInput,
  renameNode,
  starterDraft,
  updateNode,
  type Draft,
} from './workflow-model.ts'

const base = (): Draft => {
  let draft = starterDraft('builder')
  const gate = addNode(draft, 'gate')
  if ('error' in gate) throw new Error(gate.error)
  draft = gate.draft
  return draft
}

test('nodes get the first free id of their kind and are added to the draft', () => {
  const draft = base()
  expect(draft.nodes.map((n) => n.id)).toEqual(['step1', 'end1', 'gate1'])
  expect(nextNodeId(draft, 'gate')).toBe('gate2')
  expect(nextNodeId(draft, 'agent')).toBe('step2')
})

test('adding is refused past the node limit with a plain sentence', () => {
  let draft = starterDraft('builder')
  for (let i = 0; i < 28; i++) {
    const added = addNode(draft, 'join')
    if ('error' in added) throw new Error('too early')
    draft = added.draft
  }
  expect(draft.nodes).toHaveLength(30)
  expect(addNode(draft, 'end')).toEqual({ error: 'A workflow can have at most 30 nodes.' })
})

test('connect allows fan-out but not a duplicate, a self loop, or a way out of an end', () => {
  const draft = base()
  const first = connect(draft, 'gate1', 'ok', 'end1')
  expect('draft' in first).toBe(true)
  if (!('draft' in first)) return
  const second = connect(first.draft, 'gate1', 'ok', 'step1')
  expect('draft' in second).toBe(true)
  expect(connect(first.draft, 'gate1', 'ok', 'end1')).toEqual({
    error: 'Those two are already connected that way.',
  })
  expect(connect(draft, 'gate1', 'ok', 'gate1')).toEqual({
    error: 'A step cannot lead back to itself.',
  })
  expect(connect(draft, 'end1', 'ok', 'gate1')).toEqual({ error: 'An end has nothing after it.' })
  expect(connect(draft, 'gate1', 'failed', 'end1')).toMatchObject({ error: expect.any(String) })
})

test('a failure edge turns "route a failure" on, a rejection edge does the same for a gate', () => {
  let draft = base()
  const failed = connect(draft, 'step1', 'failed', 'gate1')
  if (!('draft' in failed)) throw new Error('expected a draft')
  draft = failed.draft
  expect(draft.nodes.find((n) => n.id === 'step1')).toMatchObject({ onFailure: 'route' })
  const rejected = connect(draft, 'gate1', 'rejected', 'end1')
  if (!('draft' in rejected)) throw new Error('expected a draft')
  expect(rejected.draft.nodes.find((n) => n.id === 'gate1')).toMatchObject({ onReject: 'route' })
})

test('removing a node removes the connections it had, removing a connection removes only that', () => {
  const draft = base()
  expect(draft.edges).toHaveLength(1)
  const without = removeNode(draft, 'end1')
  expect(without.edges).toEqual([])
  expect(disconnect(draft, 'e1').edges).toEqual([])
  expect(disconnect(draft, 'nope').edges).toHaveLength(1)
})

test('renaming a node updates connections, branch subjects and {{nodes.x}} references, and nothing else', () => {
  let draft = base()
  draft = updateNode(draft, 'gate1', {
    question:
      'Fine? {{nodes.step1.output}} and {{ nodes.step1.verdict|default:"-" }} but not {{nodes.step10.output}}',
  })
  const branch = addNode(draft, 'branch')
  if ('error' in branch) throw new Error(branch.error)
  draft = updateNode(branch.draft, branch.id, { subject: 'step1' })
  const renamed = renameNode(draft, 'step1', 'draft')
  expect(renamed.edges[0]).toMatchObject({ from: 'draft', to: 'end1' })
  expect(renamed.nodes.find((n) => n.id === 'branch1')).toMatchObject({ subject: 'draft' })
  const gate = renamed.nodes.find((n) => n.id === 'gate1')
  expect(gate).toMatchObject({
    question:
      'Fine? {{nodes.draft.output}} and {{ nodes.draft.verdict|default:"-" }} but not {{nodes.step10.output}}',
  })
})

test('renaming an input updates the references in instructions', () => {
  let draft = starterDraft('builder')
  draft = { ...draft, inputs: [{ name: 'topic', label: 'Topic', required: true, maxChars: 100 }] }
  draft = updateNode(draft, 'step1', {
    instruction: 'About {{inputs.topic}} and {{inputs.topic2}}',
  })
  const renamed = renameInput(draft, 'topic', 'subject')
  expect(renamed.inputs[0]!.name).toBe('subject')
  expect(renamed.nodes[0]).toMatchObject({
    instruction: 'About {{inputs.subject}} and {{inputs.topic2}}',
  })
})

test('branch rules: adding gives a fresh id, removing takes the connections out of that port with it', () => {
  let draft = base()
  const added = addNode(draft, 'branch')
  if ('error' in added) throw new Error(added.error)
  draft = addRule(added.draft, added.id)
  const branch = draft.nodes.find((n) => n.id === added.id)!
  expect(branch.kind === 'branch' && branch.rules.map((r) => r.id)).toEqual(['rule1', 'rule2'])
  expect(portsOf(branch).map((p) => p.id)).toEqual(['rule1', 'rule2', 'default'])
  const wired = connect(draft, added.id, 'rule2', 'end1')
  if (!('draft' in wired)) throw new Error('expected a draft')
  expect(removeRule(wired.draft, added.id, 'rule2').edges).toHaveLength(1)
})

test('ancestors are everything that leads into a node, not the node itself', () => {
  const draft: Draft = {
    name: 'x',
    inputs: [],
    nodes: [
      {
        id: 'a',
        kind: 'agent',
        label: 'A',
        agentId: 'b',
        instruction: 'x',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'b',
        kind: 'agent',
        label: 'B',
        agentId: 'b',
        instruction: 'x',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'c',
        kind: 'agent',
        label: 'C',
        agentId: 'b',
        instruction: 'x',
        retries: 0,
        onFailure: 'fail_run',
      },
    ],
    edges: [
      { id: 'e1', from: 'a', port: 'ok', to: 'b' },
      { id: 'e2', from: 'b', port: 'ok', to: 'c' },
    ],
  }
  expect([...ancestorsOf(draft, 'c')].sort()).toEqual(['a', 'b'])
  expect([...ancestorsOf(draft, 'a')]).toEqual([])
})

test('the outline lists nodes in reading order with where each connection goes', () => {
  const outline = outlineOf(base())
  expect(outline.map((item) => item.id)).toEqual(['step1', 'gate1', 'end1'])
  expect(outline[0]).toMatchObject({ root: true })
  expect(outline[0]!.connections[0]!.text).toBe('when done goes to Done')
  expect(outline[1]).toMatchObject({ root: true, connections: [] })
})

test('ids made from a title are valid, short and unique', () => {
  const draft = starterDraft('builder')
  expect(idFromLabel(draft, 'Write the Draft!')).toBe('write-the-draft')
  expect(idFromLabel(draft, '123 go')).toBe('go')
  expect(idFromLabel(draft, '!!!')).toBe('node')
  expect(idFromLabel(draft, 'step1')).toBe('step1-2')
  expect(idFromLabel(draft, 'step1', 'step1')).toBe('step1')
  expect(idFromLabel(draft, 'x'.repeat(60)).length).toBeLessThanOrEqual(32)
})
