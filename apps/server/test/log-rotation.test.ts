import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { rotateLog } from '../src/log-rotation.ts'

test('a log past the limit becomes one previous generation and the live file restarts empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-log-'))
  try {
    const path = join(dir, 'score.log')
    writeFileSync(path, 'x'.repeat(100))
    expect(rotateLog(path, 100)).toBe(false)
    writeFileSync(path, 'y'.repeat(101))
    expect(rotateLog(path, 100)).toBe(true)
    expect(statSync(path).size).toBe(0)
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('y'.repeat(101))
    expect(rotateLog(join(dir, 'missing.log'), 100)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
