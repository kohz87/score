import { expect, test } from 'vitest'
import { registerKnownSecret } from '../../src/redact.ts'
import {
  BoundedDiagnostics,
  boundEvent,
  boundId,
  CappedText,
  eventBytes,
  MAX_REMEMBERED_IDS,
  redactNote,
  rememberId,
} from '../../src/runtimes/coding/note.ts'

// 7.7a re-review #15 and #4: what a run keeps in memory is bounded, and stderr is redacted as a whole.

test('#15: retained commentary stops growing at its limit', () => {
  const text = new CappedText(1000)
  for (let i = 0; i < 10_000; i++) text.push('x'.repeat(50))
  expect(text.size).toBe(2000) // raw text held, twice the limit
  expect(text.value.length).toBeLessThanOrEqual(1000) // what is stored: redacted first, then cut
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

test('#18: individual retained values are bounded by bytes, not only by count', () => {
  // Long ids map to short, stable ones: distinct stay distinct, the same stays the same.
  const a = boundId('a'.repeat(100_000))
  expect(Buffer.byteLength(a)).toBeLessThanOrEqual(256)
  expect(boundId('a'.repeat(100_000))).toBe(a)
  expect(boundId('a'.repeat(100_001))).not.toBe(a)
  expect(boundId('call-1')).toBe('call-1')
  // 1,024 remembered entries of the worst-case size stay within a small fixed budget.
  const ids = new Set<string>()
  for (let i = 0; i < MAX_REMEMBERED_IDS * 2; i++)
    rememberId(ids, boundId(`${'x'.repeat(50_000)}${i}`))
  const held = [...ids].reduce((sum, id) => sum + Buffer.byteLength(id), 0)
  expect(held).toBeLessThanOrEqual(MAX_REMEMBERED_IDS * 256)
  // A tool start keeps its details to a fixed size, and the reported bytes are what is really held.
  const bounded = boundEvent({
    kind: 'tool_start',
    callId: 'c',
    tool: 't'.repeat(10_000),
    preview: 'p'.repeat(100_000),
    detail: { type: 'write', path: 'f', content: 'z'.repeat(1_000_000) },
  })
  expect(eventBytes(bounded)).toBeLessThanOrEqual(256 + 200 + 16 * 1024 + 1 + 64)
})

// ---- FW #6: redact whole CLI fields before cutting them -------------------------------------------------------------

test('FW #6: a quoted credential in a tool name is masked whole, not cut through its closing quote', () => {
  const event = boundEvent({
    kind: 'tool_start',
    callId: 'c',
    tool: `deploy password="${'hunter2 '.repeat(60)}" now`,
    preview: '',
  })
  if (event.kind !== 'tool_start') throw new Error('unexpected')
  expect(event.tool).not.toContain('hunter2')
})

test('FW #6: a registered opaque credential is replaced before a cut can leave its prefix', () => {
  const secret = 'opaque-gateway-credential-' + 'q'.repeat(300)
  registerKnownSecret(secret)
  const command = `${'x'.repeat(16 * 1024 - 40)} ${secret}`
  const event = boundEvent({
    kind: 'tool_start',
    callId: 'c',
    tool: 'Bash',
    preview: command,
    detail: { type: 'command', command },
  })
  if (event.kind !== 'tool_start' || event.detail?.type !== 'command') throw new Error('unexpected')
  expect(event.detail.command).not.toContain('opaque-gateway')
  expect(event.preview).not.toContain('opaque-gateway')
  // A long id carrying it is redacted before its prefix is kept.
  expect(boundId(`${secret}${'z'.repeat(400)}`)).not.toContain('opaque-gateway')
})

test('FW #6: stderr cut at the raw cap masks the open credential to the end instead of leaking it', () => {
  for (const open of ['password="', "token='"]) {
    const notes = new BoundedDiagnostics(256, 4096)
    notes.push('x'.repeat(200))
    notes.push(` ${open}${'spacey secret words '.repeat(40)}`)
    const text = notes.text()
    expect(text, open).not.toMatch(/spacey|secret words/)
  }
})

test('FV #3: commentary is redacted before it is cut, so a registered key at the boundary leaves no recognisable prefix', () => {
  const key = 'k'.repeat(30) + 'Q9' + 'z'.repeat(38) // a 70-byte registered gateway key
  registerKnownSecret(key)
  // Text that redaction shortens a lot (passwords) pushes the key across the limit of the sanitized text.
  const text = new CappedText(1000)
  text.push('password=hunter2 '.repeat(40))
  text.push(`the key is ${key} end`)
  const stored = text.value
  expect(stored).not.toContain(key.slice(0, 20))
  expect(stored).not.toContain('hunter2')
  // A key cut by the raw cap (the commentary kept growing) is dropped with its partial word, not stored as a prefix.
  const long = new CappedText(1000)
  long.push('a '.repeat(999))
  long.push(`${key}`)
  expect(long.value).not.toContain('kkkkkkkkkkkkkkkk')
})
