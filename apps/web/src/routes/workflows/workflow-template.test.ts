import { expect, test } from 'vitest'
import { addNode, connect, starterDraft, type Draft } from './workflow-model.ts'
import { applyOption, openReference, suggest, templateOptions } from './workflow-template.ts'

function graph(): Draft {
  let draft: Draft = {
    ...starterDraft('builder'),
    inputs: [{ name: 'topic', label: 'Topic', required: true, maxChars: 100 }],
  }
  const second = addNode(draft, 'agent', 'reviewer')
  if ('error' in second) throw new Error(second.error)
  draft = second.draft
  const join = connect(draft, 'step1', 'ok', 'step2')
  if (!('draft' in join)) throw new Error('connect')
  return join.draft
}

test('an open {{ is found before the caret and only there', () => {
  expect(openReference('Write {{inp', 11)).toEqual({ start: 6, end: 11, query: 'inp' })
  expect(openReference('Write {{inputs.a}} more', 22)).toBeNull()
  expect(openReference('Write {{inputs.a}} {{', 21)).toEqual({ start: 19, end: 21, query: '' })
  expect(openReference('no braces', 4)).toBeNull()
  expect(openReference('{{\nline', 7)).toBeNull()
  // A closing }} right after the caret is taken along, so accepting does not leave a stray pair.
  expect(openReference('a {{in}} b', 6)).toEqual({ start: 2, end: 8, query: 'in' })
})

test('suggestions are the start inputs and the outputs and verdicts of earlier agent steps only', () => {
  const draft = graph()
  expect(templateOptions(draft, 'step1').map((o) => o.label)).toEqual(['inputs.topic'])
  expect(templateOptions(draft, 'step2').map((o) => o.label)).toEqual([
    'inputs.topic',
    'nodes.step1.output',
    'nodes.step1.verdict',
  ])
  // A step never offers itself, and a node that no step leads into offers no steps.
  expect(templateOptions(draft, 'step1').some((o) => o.label.includes('step1'))).toBe(false)
  expect(templateOptions(draft, null).map((o) => o.label)).toEqual(['inputs.topic'])
})

test('suggestions narrow as the person types, ignoring capitals', () => {
  const draft = graph()
  expect(suggest(draft, 'step2', 'VERD').map((o) => o.label)).toEqual(['nodes.step1.verdict'])
  expect(suggest(draft, 'step2', '').length).toBe(3)
  expect(suggest(draft, 'step2', 'zzz')).toEqual([])
})

test('accepting writes the reference over what was typed and puts the caret after it', () => {
  const draft = graph()
  const text = 'Write about {{inp more'
  const open = openReference(text, 17)!
  const option = suggest(draft, 'step1', open.query)[0]!
  expect(applyOption(text, open, option)).toEqual({
    text: 'Write about {{inputs.topic}} more',
    caret: 'Write about {{inputs.topic}}'.length,
  })
})
