import { expect, test } from 'vitest'
import {
  cleanMapping,
  flattenPayload,
  guessMapping,
  renderTemplate,
  valueAtPath,
} from './trigger-model.ts'

const ticket = {
  event: 'ticket.created',
  ticket: {
    id: 'TCK-143',
    title: 'Export does nothing',
    url: 'https://tickets.example.com/143',
    body: 'Safari 18 does nothing.',
    labels: ['bug', 'web'],
    reporter: { name: 'Sam' },
  },
}

test('a payload flattens to the paths a mapping can use, keeping array indexes', () => {
  expect(flattenPayload(ticket).map((leaf) => leaf.path)).toEqual([
    'event',
    'ticket.id',
    'ticket.title',
    'ticket.url',
    'ticket.body',
    'ticket.labels.0',
    'ticket.labels.1',
    'ticket.reporter.name',
  ])
  expect(valueAtPath(ticket, 'ticket.labels.1')).toBe('web')
  expect(valueAtPath(ticket, 'constructor')).toBeUndefined()
})

test('field names are guessed into the four slots, and empty slots are left out', () => {
  expect(guessMapping(ticket)).toEqual({
    ref: 'ticket.id',
    title: 'ticket.title',
    link: 'ticket.url',
    details: 'ticket.body',
  })
  expect(cleanMapping({ ref: 'ticket.id', title: '', link: 'ticket.url', details: '' })).toEqual({
    ref: 'ticket.id',
    link: 'ticket.url',
  })
})

test('the preview fills holes and says which one the call lacked', () => {
  expect(renderTemplate('Fix {{ticket.title}} ({{ticket.priority}})', ticket)).toBe(
    'Fix Export does nothing ((no ticket.priority))',
  )
})
