import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AGENT_ID_PATTERN, agentIdInput } from './agent-id.ts'
import { MODEL_PATTERN } from './ModelPicker.tsx'

// Browsers compile `pattern` as `^(?:…)$` with the `v` flag and silently ignore one that doesn't compile.
const compile = (pattern: string) => new RegExp(`^(?:${pattern})$`, 'v')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.tsx')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('input patterns', () => {
  const root = join(import.meta.dirname, '..', '..')
  const literals = sources(root).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\spattern="([^"]+)"/g)].map((m) => [file, m[1]!]),
  )

  test.each(literals)('%s: %s compiles with the v flag', (_file, pattern) => {
    expect(() => compile(pattern)).not.toThrow()
  })

  test('the agent id and model patterns compile and mean what they say', () => {
    const id = compile(AGENT_ID_PATTERN)
    expect(id.test('luna')).toBe(true)
    expect(id.test('code-review_2')).toBe(true)
    expect(id.test('Luna')).toBe(false)
    expect(id.test('-luna')).toBe(false)
    expect(() => compile(MODEL_PATTERN)).not.toThrow()
  })
})

test('typed ids become valid ids', () => {
  expect(agentIdInput('Luna')).toBe('luna')
  expect(agentIdInput('Code Review')).toBe('code-review')
})
