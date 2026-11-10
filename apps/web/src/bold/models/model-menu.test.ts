import { expect, test } from 'vitest'
import { modelPaletteQuery } from '../../routes/chat/composer-model.ts'
import { parseModelArgs } from './model-command.ts'
import { modelMenuItems } from './model-menu.ts'
import { chatTagLabel, chatTagParts, isAmberChat, routineModelText } from './model-model.ts'
import type { ModelChoices } from './use-model-choices.ts'

const choice = (value: string, detail = 'Demo') => ({ value, label: value, detail })
const hermes: ModelChoices = {
  own: 'example-model',
  coding: false,
  program: 'Its program',
  programGroup: 'ITS PROGRAM',
  aliases: [choice('fast', 'example-small · Demo')],
  models: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((model) => choice(model)),
  ready: true,
}
const coding: ModelChoices = {
  own: 'sonnet',
  coding: true,
  program: 'Claude Code',
  programGroup: 'CLAUDE CODE · your Claude plan',
  aliases: [],
  models: [choice('sonnet', 'its own'), choice('opus', 'thinks longer')],
  ready: true,
}

test('a Hermes agent’s palette: aliases, up to five models with a count, then Back to its own', () => {
  const items = modelMenuItems(hermes, 'reviewer')
  expect(items[0]!.header).toBe('Model for reviewer in this chat · its own is example-model')
  expect(items.map((item) => item.insert)).toEqual([
    '/model fast',
    '/model a',
    '/model b',
    '/model c',
    '/model d',
    '/model e',
    '/model default',
  ])
  expect(items.map((item) => item.group)).toEqual([
    'ALIASES',
    'MODELS IT CAN USE · type to search',
    'MODELS IT CAN USE · type to search',
    'MODELS IT CAN USE · type to search',
    'MODELS IT CAN USE · type to search',
    'MODELS IT CAN USE · type to search',
    '',
  ])
  expect(items[5]!.after).toBe('+ 2 more: keep typing to narrow')
  expect(items.at(-1)!.description).toBe('Back to reviewer’s own (example-model)')
})

test('a coding agent lists only its own program’s models, with no alias group', () => {
  const items = modelMenuItems(coding, 'coder')
  expect(items[0]!.header).toBe('Model for coder in this chat · its own is Claude Code · sonnet')
  expect(items.map((item) => item.insert)).toEqual([
    '/model sonnet',
    '/model opus',
    '/model default',
  ])
  expect(items[0]!.group).toBe('CLAUDE CODE · your Claude plan')
  expect(items.some((item) => item.group === 'ALIASES')).toBe(false)
})

test('nothing is offered until the reads have answered', () => {
  expect(modelMenuItems({ ...hermes, ready: false }, 'reviewer')).toEqual([])
})

test('/model arguments: nothing shows the state, default goes back, anything else is a name as typed', () => {
  expect(parseModelArgs('')).toEqual({ kind: 'show' })
  expect(parseModelArgs(' Default ')).toEqual({ kind: 'own' })
  expect(parseModelArgs('Example-Large')).toEqual({ kind: 'set', name: 'Example-Large' })
})

test('the palette follows /model, bare or addressed, and only that', () => {
  expect(modelPaletteQuery('/mo')).toEqual({ agentId: null, query: '' })
  expect(modelPaletteQuery('/model')).toEqual({ agentId: null, query: '' })
  expect(modelPaletteQuery('/model de')).toEqual({ agentId: null, query: 'de' })
  expect(modelPaletteQuery('@reviewer /model ')).toEqual({ agentId: 'reviewer', query: '' })
  expect(modelPaletteQuery('@reviewer /mod')).toEqual({ agentId: 'reviewer', query: '' })
  expect(modelPaletteQuery('@reviewer /model deep')).toEqual({ agentId: 'reviewer', query: 'deep' })
  expect(modelPaletteQuery('/move')).toBeNull()
  expect(modelPaletteQuery('/model deep now')).toBeNull()
  expect(modelPaletteQuery('hello /model')).toBeNull()
})

const deep = {
  roomId: 'r',
  agentId: 'reviewer',
  model: 'example-large',
  provider: null,
  label: 'deep',
}

test('the tag: both, model only, effort only, none; the part that is its own says so', () => {
  expect(chatTagParts(deep, 'max')).toEqual({ model: 'deep', effort: 'max' })
  expect(chatTagParts(deep, null)).toEqual({ model: 'deep', effort: 'its own' })
  expect(chatTagParts(null, 'high')).toEqual({ model: 'its own', effort: 'high' })
  expect(chatTagParts(null, null)).toBeNull()
})

test('the tag is amber when the model is set differently or the effort is max, plain otherwise', () => {
  expect(isAmberChat(deep, 'low')).toBe(true)
  expect(isAmberChat(deep, null)).toBe(true)
  expect(isAmberChat(null, 'max')).toBe(true)
  expect(isAmberChat(null, 'high')).toBe(false)
})

test('the tag’s accessible name says both parts', () => {
  expect(chatTagLabel('reviewer', deep, 'max')).toBe(
    'reviewer in this chat: model deep, effort max. Change',
  )
  expect(chatTagLabel('reviewer', null, null)).toBe(
    'reviewer in this chat: its own model and effort. Set for this chat',
  )
})

test('a repeating job’s model: pinned, or following the agent', () => {
  expect(routineModelText('deep', 'example-model')).toEqual({ model: 'deep', how: 'pinned' })
  expect(routineModelText(null, 'example-model')).toEqual({
    model: 'its own · example-model',
    how: 'follows the agent',
  })
})
