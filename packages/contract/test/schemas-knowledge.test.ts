import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { knowledgeCases } from './schemas-cases-knowledge.ts'

describe.each(knowledgeCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('Knowledge notes may be 8 MiB; embedded images are 1.5 MiB and never SVG (PLAN 6.8)', () => {
  expect(contract.KNOWLEDGE_NOTE_MAX_BYTES).toBe(8 * 1024 * 1024)
  expect(contract.KNOWLEDGE_IMAGE_MAX_BYTES).toBe(1.5 * 1024 * 1024)
  expect([...contract.KNOWLEDGE_IMAGE_TYPES]).toEqual([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])
  const write = (body: string) =>
    contract.KnowledgeWriteRequestSchema.safeParse({ body, etag: null })
  expect(write('a'.repeat(contract.KNOWLEDGE_NOTE_MAX_BYTES)).success).toBe(true)
  expect(write('a'.repeat(contract.KNOWLEDGE_NOTE_MAX_BYTES + 1)).success).toBe(false)
})
