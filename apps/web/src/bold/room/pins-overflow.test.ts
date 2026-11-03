import { expect, test } from 'vitest'
import { cardsBelow } from './pins-overflow.ts'

const cards = [
  { top: 0, bottom: 200 },
  { top: 212, bottom: 420 },
  { top: 432, bottom: 600 },
]

test('no cue when every card is in view', () => {
  expect(cardsBelow({ scrollTop: 0, clientHeight: 600 }, cards)).toBeNull()
  expect(cardsBelow({ scrollTop: 0, clientHeight: 300 }, [cards[0]!])).toBeNull()
})

test('the cue counts the cards not fully in view and aims at the next one', () => {
  expect(cardsBelow({ scrollTop: 0, clientHeight: 300 }, cards)).toEqual({
    count: 2,
    scrollTo: 212,
  })
  // Scrolled to the second card: the third is the one below.
  expect(cardsBelow({ scrollTop: 212, clientHeight: 300 }, cards)).toEqual({
    count: 1,
    scrollTo: 432,
  })
})

test('a single card cut off at the bottom still shows the cue and scrolls to its end', () => {
  expect(cardsBelow({ scrollTop: 0, clientHeight: 150 }, [cards[0]!])).toEqual({
    count: 1,
    scrollTo: 50,
  })
})
