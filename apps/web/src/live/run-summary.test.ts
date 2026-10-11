import { describe, expect, it } from 'vitest'
import { durationText, secondsBetween, spendText, summaryLine } from './run-summary.ts'

describe('summaryLine', () => {
  it('joins every known fact', () => {
    expect(
      summaryLine({
        toolCalls: 6,
        approvals: 2,
        compacted: { before: 34_000, after: 12_000 },
        spendUsd: 0.009,
        spendEstimated: true,
        durationSec: 180,
      }),
    ).toBe('6 tool calls · 2 approvals · context compacted 34k → 12k · $0.009 (estimated) · 3 min')
  })

  it('leaves out what is unknown and never invents zeros', () => {
    expect(summaryLine({ steps: 3, durationSec: 42 })).toBe('3 steps · 42 seconds')
    expect(summaryLine({ toolCalls: null, approvals: 0, spendUsd: null })).toBeNull()
    expect(summaryLine({})).toBeNull()
  })

  it('keeps a known spend of zero, because that is a fact', () => {
    expect(summaryLine({ spendUsd: 0 })).toBe('$0.000')
  })

  it('uses singular forms and settled spend', () => {
    expect(summaryLine({ toolCalls: 1, approvals: 1, spendUsd: 2.5 })).toBe(
      '1 tool call · 1 approval · $2.50',
    )
  })
})

describe('helpers', () => {
  it('formats durations and spend', () => {
    expect(durationText(5)).toBe('5 seconds')
    expect(durationText(3600 + 300)).toBe('1 h 5 min')
    expect(durationText(7200)).toBe('2 h')
    expect(spendText(0.0094, false)).toBe('$0.009')
  })
  it('reads the time between two instants', () => {
    expect(secondsBetween('2026-10-11T10:00:00Z', '2026-10-11T10:03:00Z')).toBe(180)
    expect(secondsBetween(null, '2026-10-11T10:03:00Z')).toBeNull()
    expect(secondsBetween('2026-10-11T10:03:00Z', '2026-10-11T10:00:00Z')).toBeNull()
  })
})
