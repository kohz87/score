import { describe, expect, test } from 'vitest'
import { decodeReceipt, encodeReceipt } from '../../src/receipt-codec.ts'
import { setupKanbanAttemptsConsumersTest } from './kanban-attempts-consumers-helpers.ts'

setupKanbanAttemptsConsumersTest()

describe('receipts', () => {
  test('the receipt codec round-trips an answer larger than the table accepts', () => {
    const answer = JSON.stringify({ text: 'q'.repeat(200_000) })
    const stored = encodeReceipt(answer, '/api/rooms')
    expect(stored).toContain('scoreReceiptGzip')
    expect(JSON.stringify(decodeReceipt(stored, 1_000_000))).toBe(answer)
  })
})
