import type { WorkflowDefinition, WorkflowNode } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { definitionHash, validateDefinition } from '../../src/domain/workflows/definition.ts'
import { agent, branch, definition, edge, end, gate, join } from './wf-harness.ts'

const codes = (def: WorkflowDefinition): string[] =>
  [...new Set(validateDefinition(def).issues.map((i) => i.code))].sort()
const ok = (def: WorkflowDefinition): void => {
  expect(validateDefinition(def).issues).toEqual([])
}
const e = (from: string, to: string, port = 'ok', id?: string) => ({
  ...edge(from, to, port),
  ...(id ? { id } : {}),
})

describe('a valid graph', () => {
  test('the smallest graph and a branch reconverging through a join are valid', () => {
    ok(definition([agent('a'), end()], [e('a', 'done')]))
    ok(
      definition(
        [
          agent('a'),
          branch('b', 'a', [{ id: 'r', when: { kind: 'output_contains', text: 'ship' } }]),
          agent('x'),
          agent('y'),
          join('j'),
          end(),
        ],
        [
          e('a', 'b'),
          e('b', 'x', 'r'),
          e('b', 'y', 'default'),
          e('x', 'j'),
          e('y', 'j'),
          e('j', 'done'),
        ],
      ),
    )
  })
  test('fan-out from one port to two agents joined is valid, and a hash is stable', () => {
    const def = definition(
      [agent('root'), agent('l'), agent('r'), join('j'), end()],
      [e('root', 'l'), e('root', 'r'), e('l', 'j'), e('r', 'j'), e('j', 'done')],
    )
    ok(def)
    expect(definitionHash(def)).toBe(
      definitionHash(JSON.parse(JSON.stringify(def)) as WorkflowDefinition),
    )
    expect(definitionHash(def)).not.toBe(definitionHash({ ...def, name: 'other' }))
  })
  test('a template may use an input, a dominating ancestor, or any ancestor with a default', () => {
    ok(
      definition(
        [
          agent('a'),
          agent('b', { instruction: '{{inputs.t}} {{nodes.a.output}} {{nodes.a.verdict}}' }),
          end(),
        ],
        [e('a', 'b'), e('b', 'done')],
        [{ name: 't', label: 'T', required: true, maxChars: 10 }],
      ),
    )
  })
})

describe('every rule has a counterexample', () => {
  const chain = (...nodes: WorkflowNode[]) => nodes
  test.each<[string, () => WorkflowDefinition]>([
    [
      'too_many_nodes',
      () => definition(Array.from({ length: 31 }, (_, i) => agent(`n${i}`)).concat([end()]), []),
    ],
    [
      'too_many_edges',
      () =>
        definition(
          [agent('a'), end()],
          Array.from({ length: 101 }, (_, i) => e('a', 'done', 'ok', `x${i}`)),
        ),
    ],
    [
      'definition_too_large',
      () => definition([agent('a', { instruction: 'x'.repeat(300_000) }), end()], [e('a', 'done')]),
    ],
    [
      'steps_over_limit',
      () =>
        definition(
          [...Array.from({ length: 11 }, (_, i) => agent(`n${i}`, { retries: 2 })), end()],
          [],
        ),
    ],
    ['duplicate_node_id', () => definition([agent('a'), agent('a'), end()], [e('a', 'done')])],
    [
      'duplicate_edge_id',
      () =>
        definition(
          [agent('a'), agent('b'), end()],
          [e('a', 'b', 'ok', 'same'), e('b', 'done', 'ok', 'same')],
        ),
    ],
    [
      'duplicate_edge',
      () => definition([agent('a'), end()], [e('a', 'done'), e('a', 'done', 'ok', 'other')]),
    ],
    [
      'duplicate_input',
      () =>
        definition(
          [agent('a'), end()],
          [e('a', 'done')],
          [
            { name: 'x', label: 'x', required: false, maxChars: 5 },
            { name: 'x', label: 'y', required: false, maxChars: 5 },
          ],
        ),
    ],
    ['unknown_node', () => definition([agent('a'), end()], [e('a', 'done'), e('a', 'ghost')])],
    [
      'bad_port',
      () => definition([agent('a'), end()], [e('a', 'done'), e('a', 'done', 'maybe', 'x2')]),
    ],
    ['no_root', () => definition([agent('a'), agent('b')], [e('a', 'b'), e('b', 'a')])],
    [
      'bad_root_kind',
      () => definition([agent('a'), join('j'), end()], [e('a', 'done'), e('j', 'done')]),
    ],
    [
      'cycle',
      () =>
        definition(
          [agent('s'), agent('a'), agent('b'), end()],
          [e('s', 'a'), e('a', 'b'), e('b', 'a', 'ok', 'back'), e('b', 'done', 'ok', 'out')],
        ),
    ],
    [
      'unreachable_node',
      () =>
        definition(
          [agent('a'), end(), join('j'), join('k')],
          [e('a', 'done'), e('j', 'k'), e('k', 'j', 'ok', 'b2')],
        ),
    ],
    ['no_end', () => definition(chain(agent('a'), agent('b')), [e('a', 'b')])],
    [
      'end_has_outgoing',
      () => definition([agent('a'), end('e1'), end('e2')], [e('a', 'e1'), e('e1', 'e2')]),
    ],
    [
      'unrouted_failure',
      () => definition([agent('a', { onFailure: 'route' }), end()], [e('a', 'done')]),
    ],
    [
      'unrouted_rejection',
      () => definition([gate('g', { onReject: 'route' }), end()], [e('g', 'done')]),
    ],
    [
      'failure_edge_with_fail_run',
      () => definition([agent('a'), end()], [e('a', 'done'), e('a', 'done', 'failed', 'x3')]),
    ],
    [
      'port_unconnected',
      () =>
        definition([agent('a'), agent('b'), end()], [e('a', 'b'), e('a', 'done', 'failed', 'x4')]),
    ],
    [
      'branch_no_default',
      () =>
        definition(
          [
            agent('a'),
            branch('b', 'a', [{ id: 'r', when: { kind: 'verdict', is: 'passed' } }]),
            end(),
          ],
          [e('a', 'b'), e('b', 'done', 'r')],
        ),
    ],
    [
      'branch_duplicate_rule',
      () =>
        definition(
          [
            agent('a'),
            branch('b', 'a', [
              { id: 'r', when: { kind: 'verdict', is: 'passed' } },
              { id: 'r', when: { kind: 'verdict', is: 'changes_requested' } },
            ]),
            end(),
          ],
          [e('a', 'b'), e('b', 'done', 'r'), e('b', 'done', 'default', 'x5')],
        ),
    ],
    [
      'branch_subject_invalid',
      () =>
        definition(
          [
            agent('a'),
            branch('b', 'later', [{ id: 'r', when: { kind: 'verdict', is: 'passed' } }]),
            agent('later'),
            end(),
          ],
          [
            e('a', 'b'),
            e('b', 'later', 'r'),
            e('b', 'done', 'default'),
            e('later', 'done', 'ok', 'x6'),
          ],
        ),
    ],
    [
      'branch_condition_unusable',
      () =>
        definition(
          [
            agent('a'),
            branch('b', 'a', [{ id: 'r', when: { kind: 'outcome', is: 'failed' } }]),
            end(),
          ],
          [e('a', 'b'), e('b', 'done', 'r'), e('b', 'done', 'default', 'x7')],
        ),
    ],
    [
      'join_needs_inputs',
      () => definition([agent('a'), join('j'), end()], [e('a', 'j'), e('j', 'done')]),
    ],
    [
      'template_syntax',
      () =>
        definition([agent('a', { instruction: 'oops {{ whatever }}' }), end()], [e('a', 'done')]),
    ],
    [
      'template_unknown_input',
      () => definition([agent('a', { instruction: '{{inputs.zz}}' }), end()], [e('a', 'done')]),
    ],
    [
      'template_unknown_node',
      () =>
        definition([agent('a', { instruction: '{{nodes.zz.output}}' }), end()], [e('a', 'done')]),
    ],
    [
      'template_self_reference',
      () =>
        definition([agent('a', { instruction: '{{nodes.a.output}}' }), end()], [e('a', 'done')]),
    ],
    [
      'template_forward_reference',
      () =>
        definition(
          [agent('a', { instruction: '{{nodes.b.output}}' }), agent('b'), end()],
          [e('a', 'b'), e('b', 'done')],
        ),
    ],
    [
      'template_not_ancestor',
      () =>
        definition(
          [agent('a'), agent('b', { instruction: '{{nodes.a.output}}' }), end()],
          [e('a', 'done'), e('b', 'done', 'ok', 'x8')],
        ),
    ],
    [
      'template_needs_default',
      () =>
        definition(
          [
            agent('s'),
            branch('b', 's', [{ id: 'r', when: { kind: 'output_contains', text: 'x' } }]),
            agent('x'),
            agent('y'),
            join('j'),
            agent('c', { instruction: '{{nodes.x.output}}' }),
            end(),
          ],
          [
            e('s', 'b'),
            e('b', 'x', 'r'),
            e('b', 'y', 'default'),
            e('x', 'j'),
            e('y', 'j'),
            e('j', 'c'),
            e('c', 'done'),
          ],
        ),
    ],
    [
      'template_field_unavailable',
      () =>
        definition(
          [gate('g'), agent('c', { instruction: '{{nodes.g.output}}' }), end()],
          [e('g', 'c'), e('c', 'done')],
        ),
    ],
  ])('%s', (code, make) => {
    expect(codes(make())).toContain(code)
  })

  test('a default on the conditional reference makes the same graph valid', () => {
    const base = [
      agent('s'),
      branch('b', 's', [{ id: 'r', when: { kind: 'output_contains', text: 'x' } }]),
      agent('x'),
      agent('y'),
      join('j'),
      agent('c', { instruction: '{{nodes.x.output|default:"none"}}' }),
      end(),
    ]
    ok(
      definition(base, [
        e('s', 'b'),
        e('b', 'x', 'r'),
        e('b', 'y', 'default'),
        e('x', 'j'),
        e('y', 'j'),
        e('j', 'c'),
        e('c', 'done'),
      ]),
    )
  })
})

describe('layout is presentation only (7.1c)', () => {
  // One graph: edge ids come from a counter, so a second call would differ for reasons that are not the layout.
  const graph = definition([agent('a'), end()], [e('a', 'done')])
  const base = () => graph
  const withLayout = (nodes: Record<string, { x: number; y: number }>): WorkflowDefinition => ({
    ...base(),
    layout: { nodes },
  })

  test('positions never change whether a graph is valid, and a partial layout is fine', () => {
    ok(withLayout({ a: { x: 0, y: 0 } }))
    ok(withLayout({ a: { x: 500, y: 20 }, done: { x: 16, y: 400 } }))
    expect(validateDefinition(withLayout({ a: { x: 1, y: 1 } })).stats).toMatchObject({
      nodes: 2,
      edges: 1,
    })
  })

  test('a position for a node that does not exist is layout_unknown_node on that id', () => {
    const result = validateDefinition(withLayout({ ghost: { x: 0, y: 0 } }))
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'layout_unknown_node', nodeId: 'ghost', severity: 'error' }),
    ])
  })

  test('the layout is part of the hash: moving a node is a different version, the same layout is not', () => {
    const a = withLayout({ a: { x: 16, y: 16 } })
    expect(definitionHash(a)).not.toBe(definitionHash(base()))
    expect(definitionHash(a)).not.toBe(definitionHash(withLayout({ a: { x: 32, y: 16 } })))
    expect(definitionHash(a)).toBe(
      definitionHash(JSON.parse(JSON.stringify(a)) as WorkflowDefinition),
    )
    // Key order does not matter.
    expect(definitionHash(withLayout({ a: { x: 1, y: 2 }, done: { x: 3, y: 4 } }))).toBe(
      definitionHash(withLayout({ done: { y: 4, x: 3 }, a: { y: 2, x: 1 } })),
    )
  })
})
