import type { CodingQuota } from '@score/contract'
import { describe, expect, it } from 'vitest'
import { antigravityGroupOf, belowFloor } from '../../src/runtimes/coding/quota-floor.ts'

const NOW = Date.parse('2026-10-17T10:00:00Z')
const FUTURE = '2026-10-17T13:40:00.000Z'
const PAST = '2026-10-17T09:00:00.000Z'

const reading = (
  windows: CodingQuota['windows'],
  runtime: CodingQuota['runtime'] = 'claude-code',
): CodingQuota => ({ runtime, seenAt: '2026-10-17T09:59:00.000Z', windows, source: 'turn' })

describe('belowFloor', () => {
  it('is null without a reading, and with floor 0', () => {
    expect(belowFloor(null, 10, NOW, null)).toBeNull()
    expect(belowFloor(undefined, 10, NOW, null)).toBeNull()
    const low = reading([{ name: '5 hours', group: null, usedPercent: 99, resetsAt: FUTURE }])
    expect(belowFloor(low, 0, NOW, null)).toBeNull()
  })

  it('finds a window with less than the floor left and a reset ahead', () => {
    const low = reading([
      { name: '5 hours', group: null, usedPercent: 94, resetsAt: FUTURE },
      { name: 'week', group: null, usedPercent: 20, resetsAt: FUTURE },
    ])
    expect(belowFloor(low, 10, NOW, null)).toEqual({
      window: '5 hours',
      group: null,
      leftPercent: 6,
      resetsAt: FUTURE,
    })
  })

  it('treats exactly the floor as fine, and picks the lowest window', () => {
    const edge = reading([{ name: '5 hours', group: null, usedPercent: 90, resetsAt: FUTURE }])
    expect(belowFloor(edge, 10, NOW, null)).toBeNull()
    const two = reading([
      { name: '5 hours', group: null, usedPercent: 95, resetsAt: FUTURE },
      { name: 'week', group: null, usedPercent: 98, resetsAt: FUTURE },
    ])
    expect(belowFloor(two, 10, NOW, null)?.window).toBe('week')
  })

  it('never counts an unknown share, an unknown reset or a reset that has passed', () => {
    expect(
      belowFloor(
        reading([{ name: '5 hours', group: null, usedPercent: null, resetsAt: FUTURE }]),
        10,
        NOW,
        null,
      ),
    ).toBeNull()
    expect(
      belowFloor(
        reading([{ name: '5 hours', group: null, usedPercent: 99, resetsAt: null }]),
        10,
        NOW,
        null,
      ),
    ).toBeNull()
    expect(
      belowFloor(
        reading([{ name: '5 hours', group: null, usedPercent: 99, resetsAt: PAST }]),
        10,
        NOW,
        null,
      ),
    ).toBeNull()
    expect(belowFloor(reading([]), 10, NOW, null)).toBeNull()
  })

  describe('Antigravity groups', () => {
    const usage = reading(
      [
        { name: '5 hours', group: 'Gemini Models', usedPercent: 50, resetsAt: FUTURE },
        { name: '5 hours', group: 'Claude and GPT models', usedPercent: 97, resetsAt: FUTURE },
        { name: 'week', group: 'Gemini 4 Argon', usedPercent: 96, resetsAt: FUTURE },
      ],
      'antigravity',
    )

    it('maps model ids to groups', () => {
      expect(antigravityGroupOf('gemini-4-argon-medium')).toBe('Gemini 4 Argon')
      expect(antigravityGroupOf('gemini-3.8-flash-high')).toBe('Gemini Models')
      expect(antigravityGroupOf('claude-opus-5-5-low')).toBe('Claude and GPT models')
      expect(antigravityGroupOf('gpt-oss-120b-medium')).toBe('Claude and GPT models')
      expect(antigravityGroupOf(null)).toBe('Gemini Models')
      expect(antigravityGroupOf('something-new')).toBeNull()
    })

    it('looks only at the model’s own group', () => {
      expect(belowFloor(usage, 10, NOW, 'gemini-3.8-flash-high')).toBeNull()
      expect(belowFloor(usage, 10, NOW, null)).toBeNull()
      expect(belowFloor(usage, 10, NOW, 'claude-sonnet-5-5-high')?.group).toBe(
        'Claude and GPT models',
      )
      expect(belowFloor(usage, 10, NOW, 'gemini-4-argon-low')?.group).toBe('Gemini 4 Argon')
    })

    it('looks at every group when the model is unknown', () => {
      expect(belowFloor(usage, 10, NOW, 'something-new')?.leftPercent).toBe(3)
    })
  })
})
