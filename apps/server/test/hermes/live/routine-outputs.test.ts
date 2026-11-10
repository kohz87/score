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

test('the answer is read as Hermes reads it: by its stated length, or under the last Response heading', () => {
  const prompt = 'Sum up.\n## Response\nnot the answer'
  const framed =
    `# Cron Job: Digest\n\n**Prompt Characters:** ${Array.from(prompt).length}\n## Prompt\n\n${prompt}\n\n` +
    `**Response Characters:** 9\n## Response\n\nAll green\n`
  expect(outputText(framed)).toBe('All green')
  expect(outputText('# Cron Job: Digest\n\n## Prompt\n\nx\n\n## Response\n\nDone.\n')).toBe('Done.')
  // A failed or blocked run has no answer, and its document repeats the prompt: nothing of it is used.
  expect(
    outputText('# Cron Job: Digest (FAILED)\n\nSum up my secret plan.\n\nNo key.\n'),
  ).toBeNull()
  expect(
    outputText(
      `**Prompt Characters:** 3\n## Prompt\n\nabc\n\n**Response Characters:** 99\n## Response\n\ncut\n`,
    ),
  ).toBeNull()
})

test('a folder on the way that is a link is not followed', () => {
  const outside = fs.mkdtempSync(join(tmpdir(), 'score-outside-'))
  fs.mkdirSync(join(outside, 'a1b2c3d4e5f6'))
  fs.writeFileSync(join(outside, 'a1b2c3d4e5f6', '2026-11-12_08-00-00.md'), '## Response\nsecret')
  fs.rmSync(join(home, 'profiles', 'builder', 'cron', 'output'), { recursive: true })
  fs.symlinkSync(outside, join(home, 'profiles', 'builder', 'cron', 'output'))
  expect(readRoutineOutputs(home, 'builder:a1b2c3d4e5f6', '2026-01-01T00:00:00.000Z')).toEqual([])
  fs.rmSync(outside, { recursive: true, force: true })
})

test('a long backlog comes oldest first, a page at a time', () => {
  for (let day = 1; day <= 25; day += 1) {
    const stamp = `2026-11-${String(day).padStart(2, '0')}`
    write(`${stamp}_08-00-00.md`, `## Response\nday ${day}`, new Date(`${stamp}T00:00:00Z`))
  }
  const first = readRoutineOutputs(home, 'builder:a1b2c3d4e5f6', '2026-01-01T00:00:00.000Z')
  expect(first).toHaveLength(20)
  expect(first[0]!.text).toBe('day 1')
  const next = readRoutineOutputs(home, 'builder:a1b2c3d4e5f6', first.at(-1)!.at)
  expect(next.map((one) => one.text)).toEqual([
    'day 20',
    'day 21',
    'day 22',
    'day 23',
    'day 24',
    'day 25',
  ])
})

test('only results saved after the time, oldest first, redacted; other files and a missing folder are nothing', () => {
  write('2026-11-10_08-00-00.md', '## Response\nold', new Date('2026-11-09T00:00:00Z'))
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
