import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const policyUrl = new URL('../../../../scripts/license-policy.mjs', import.meta.url)
const load = async () =>
  (await import(fileURLToPath(policyUrl))) as {
    permitted(expr: string, isFont: boolean): boolean
  }

test('fix-l: the license policy is exactly AGENTS.md (no MIT-0, OFL only for fonts)', async () => {
  const { permitted } = await load()
  for (const ok of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '(MIT OR GPL-3.0)'])
    expect(permitted(ok, false), ok).toBe(true)
  expect(permitted('MIT-0', false)).toBe(false)
  expect(permitted('(MIT AND MIT-0)', false)).toBe(false)
  expect(permitted('OFL-1.1', false)).toBe(false)
  expect(permitted('OFL-1.1', true)).toBe(true)
})
