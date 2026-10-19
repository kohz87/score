import { expect, test, vi } from 'vitest'
import { mentionInsertion, onMention, requestMention } from './composer-mention.ts'

test('a mention goes in at the caret, with a space before it when the text needs one', () => {
  expect(mentionInsertion('', 0, 'builder')).toEqual({ text: '@builder ', caret: 9 })
  expect(mentionInsertion('hello', 5, 'builder')).toEqual({ text: 'hello @builder ', caret: 15 })
  expect(mentionInsertion('hello ', 6, 'builder')).toEqual({ text: 'hello @builder ', caret: 15 })
  expect(mentionInsertion('hello\n', 6, 'lead')).toEqual({ text: 'hello\n@lead ', caret: 12 })
  // In the middle: the rest stays after it, without a doubled space.
  expect(mentionInsertion('ask  now', 4, 'lead')).toEqual({ text: 'ask @lead now', caret: 10 })
  expect(mentionInsertion('ask now', 4, 'lead')).toEqual({ text: 'ask @lead now', caret: 10 })
  expect(mentionInsertion('abc', 99, 'lead')).toEqual({ text: 'abc @lead ', caret: 10 })
})

test('a request reaches the listener of that room only', () => {
  const mine = vi.fn()
  const other = vi.fn()
  const stopMine = onMention('room-1', mine)
  const stopOther = onMention('room-2', other)
  requestMention('room-1', 'builder')
  stopMine()
  stopOther()
  requestMention('room-1', 'lead')
  expect(mine).toHaveBeenCalledTimes(1)
  expect(mine).toHaveBeenCalledWith('builder')
  expect(other).not.toHaveBeenCalled()
})
