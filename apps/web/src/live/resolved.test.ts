import { describe, expect, it } from 'vitest'
import type { Approval } from '@score/contract'
import { approvalChip, chipText, clock, gateChip } from './resolved.ts'

const at = '2026-10-11T14:02:00.000Z'
const base = {
  status: 'approved',
  delivery: 'applied',
  decision: { choice: 'once', by: 'you', at },
} as unknown as Approval
const make = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as unknown as Approval

describe('approvalChip', () => {
  it('says what you chose, with the time', () => {
    const chip = approvalChip(base)!
    expect(chip).toEqual({ tone: 'ok', text: 'Approved by you', at })
    expect(chipText(chip)).toBe(`Approved by you · ${clock(at)}`)
    expect(approvalChip(make({ decision: { choice: 'deny', by: 'you', at } }))).toMatchObject({
      tone: 'no',
      text: 'Rejected',
    })
    expect(approvalChip(make({ decision: { choice: 'always', by: 'you', at } }))?.text).toBe(
      'Always allowed',
    )
    expect(approvalChip(make({ decision: { choice: 'session', by: 'you', at } }))?.text).toBe(
      'Approved for this session',
    )
  })
  it('names who else decided, and keeps neutral outcomes neutral', () => {
    expect(approvalChip(make({ decision: { choice: 'once', by: 'guardian', at } }))?.text).toBe(
      'Guardian approved this',
    )
    expect(approvalChip(make({ decision: { choice: 'deny', by: 'timeout', at } }))).toMatchObject({
      tone: 'neutral',
      text: 'Timed out',
    })
    expect(approvalChip(make({ delivery: 'not_pending' }))?.text).toBe('Answered elsewhere')
  })
  it('is null while the question is open or its answer is on the way', () => {
    expect(approvalChip(make({ status: 'pending', decision: null, delivery: 'none' }))).toBeNull()
    expect(approvalChip(make({ delivery: 'delivering' }))).toBeNull()
  })
})

describe('gateChip', () => {
  it('turns a decided gate into a chip and leaves the others out', () => {
    expect(gateChip({ status: 'approved', decidedAt: at })).toEqual({
      tone: 'ok',
      text: 'Approved by you',
      at,
    })
    expect(gateChip({ status: 'rejected', decidedAt: at })).toMatchObject({
      tone: 'no',
      text: 'Rejected',
    })
    expect(gateChip({ status: 'open', decidedAt: null })).toBeNull()
    expect(gateChip({ status: 'withdrawn', decidedAt: null })).toBeNull()
  })
})
