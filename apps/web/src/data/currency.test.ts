import { expect, test } from 'vitest'
import { convertUsd, formatMoney, USD } from './currency.ts'

test('USD passes through to the cent and unknown stays a dash', () => {
  expect(formatMoney(41.2)).toBe('$41.20')
  expect(formatMoney(null)).toBe('—')
  expect(convertUsd(1.005, USD)).toBe(1.01)
})

test('a typed rate converts and rounds once, at the displayed cent', () => {
  const eur = { code: 'EUR', rate: 0.92 }
  expect(convertUsd(10, eur)).toBe(9.2)
  expect(convertUsd(1.234, eur)).toBe(1.14)
  expect(formatMoney(10, eur)).toBe('€9.20')
  expect(formatMoney(0, eur)).toBe('€0.00')
})

test('a code with no known formatting falls back to the plain code', () => {
  expect(formatMoney(2, { code: 'ZZZ', rate: 3 })).toMatch(/ZZZ\s?6\.00/)
})
