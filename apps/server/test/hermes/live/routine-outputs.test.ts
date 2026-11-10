import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { outputText, readRoutineOutputs } from '../../../src/hermes/live/routine-outputs.ts'

// Decision 183: Score reads a job's saved results read-only, newest after a time, redacted.
let home: string
const folder = () => join(home, 'profiles', 'builder', 'cron', 'output', 'a1b2c3d4e5f6')
const write = (name: string, text: string, mtime: Date) => {
  fs.writeFileSync(join(folder(), name), text)
  fs.utimesSync(join(folder(), name), mtime, mtime)
}
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-outputs-'))
  fs.mkdirSync(folder(), { recursive: true })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

test('the answer is the part under Response when the document has one', () => {
  expect(outputText('# Cron Job: Digest\n\n**Run Time:** now\n\n## Response\n\nAll green.\n')).toBe(
    'All green.',
  )
  expect(outputText('# Cron Job: Digest (FAILED)\n\nNo key.\n')).toBe(
    '# Cron Job: Digest (FAILED)\n\nNo key.',
  )
})

test('only results saved after the time, oldest first, redacted; other files and a missing folder are nothing', () => {
  write('2026-11-10_08-00-00.md', '## Response\nold', new Date('2026-11-10T00:00:00Z'))
  write(
    '2026-11-11_08-00-00.md',
    '## Response\nUse token=abcdefghijklmnopqrstuvwxyz0123456789ABCD here',
    new Date('2026-11-11T00:00:00Z'),
  )
  write('2026-11-12_08-00-00.md', '## Response\nnewest', new Date('2026-11-12T00:00:00Z'))
  write('notes.txt', 'not a result', new Date('2026-11-12T00:00:00Z'))
  const found = readRoutineOutputs(home, 'builder:a1b2c3d4e5f6', '2026-11-10T12:00:00.000Z')
  expect(found.map((one) => one.file)).toEqual(['2026-11-11_08-00-00.md', '2026-11-12_08-00-00.md'])
  expect(found[0]!.text).toContain('[redacted]')
  expect(found[1]!.text).toBe('newest')
  expect(readRoutineOutputs(home, 'builder:0f1e2d3c4b5a', '2026-01-01T00:00:00.000Z')).toEqual([])
})
