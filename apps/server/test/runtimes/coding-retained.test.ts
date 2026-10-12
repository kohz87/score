import { expect, test } from 'vitest'
import {
  CappedText,
  MAX_REMEMBERED_IDS,
  redactNote,
  rememberId,
} from '../../src/runtimes/coding/note.ts'
import { BoundedDiagnostics } from '../../src/runtimes/coding/unit-backend.ts'

// 7.7a re-review #15 and #4: what a run keeps in memory is bounded, and stderr is redacted as a whole.

test('#15: retained commentary stops growing at its limit', () => {
  const text = new CappedText(1000)
  for (let i = 0; i < 10_000; i++) text.push('x'.repeat(50))
  expect(text.size).toBe(1000)
  expect(text.value.length).toBe(1000)
})

test('#15: remembered call ids forget the oldest past the limit', () => {
  const ids = new Set<string>()
  for (let i = 0; i < MAX_REMEMBERED_IDS * 3; i++) rememberId(ids, `call-${i}`)
  expect(ids.size).toBe(MAX_REMEMBERED_IDS)
  expect(ids.has('call-0')).toBe(false)
  expect(ids.has(`call-${MAX_REMEMBERED_IDS * 3 - 1}`)).toBe(true)
})

test('#4: a labelled secret with a value longer than the kept tail is masked, not left as an unlabeled tail', () => {
  const notes = new BoundedDiagnostics()
  notes.push('password=')
  for (let i = 0; i < 10; i++) notes.push('v'.repeat(1000))
  const text = notes.text()
  expect(text).not.toMatch(/v{10}/)
  expect(text).toContain('password=[redacted]')
})

test('#4: past the raw limit the rest is dropped, never kept as unlabeled text', () => {
  const notes = new BoundedDiagnostics(2048, 512)
  notes.push('failed: ')
  notes.push('a'.repeat(100_000))
  notes.push('token=')
  notes.push('s'.repeat(5000))
  expect(notes.text()).not.toContain('sss')
  expect(notes.text().length).toBeLessThanOrEqual(520)
})

test('#3: a colon before a credential label does not hide it from the redactor', () => {
  expect(redactNote('Antigravity refused: password=review-sentinel. Done', 400)).not.toContain(
    'review-sentinel',
  )
})
