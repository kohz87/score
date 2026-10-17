import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { protectedClasses } from '../themes/protected-surfaces.ts'

// Keeps styles/protected.css, themes/protected-surfaces.ts and the markup in step: a component that wears one of the
// protected classes must carry data-protected, and every kind it uses must be one protected.css knows.
const root = join(__dirname, '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : []
  })
}

// Classes that are used as plain markers; chat-toast is only protected on the error toast, agent-glyph is built in code.
const jsxClasses = protectedClasses.filter(
  (name) =>
    ![
      'chat-toast',
      'agent-glyph',
      'look-reset',
      'guard-form',
      'security-password',
      'admin-password',
      'team-permissions',
    ].includes(name) && !name.startsWith('look-banner'),
)

test('every element that wears a protected class is marked data-protected', () => {
  const missing: string[] = []
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8')
    const pattern = new RegExp(
      `className=(?:"|\\{\`)[^"\`]*\\b(${jsxClasses.join('|')})(?![\\w-])`,
      'g',
    )
    for (const match of text.matchAll(pattern)) {
      const start = text.lastIndexOf('<', match.index)
      const window = text.slice(Math.max(0, start - 200), match.index + 700)
      if (!window.includes('data-protected')) missing.push(`${file}: ${match[1]}`)
    }
  }
  expect(missing).toEqual([])
})

test('every data-protected kind in the markup is one protected.css handles', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  const kinds = new Set<string>()
  for (const file of sources(root))
    for (const match of readFileSync(file, 'utf8').matchAll(/data-protected(?:="([a-z-]*)")?/g))
      kinds.add(match[1] ?? 'any')
  for (const kind of kinds) {
    if (kind === 'any') continue
    expect(css, kind).toContain(`[data-protected='${kind}']`)
  }
  expect(kinds.size).toBeGreaterThan(3)
})

test('the protected layer re-asserts what a hostile theme would change, with !important', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  expect(css).toContain('@layer score-protected')
  for (const property of [
    'opacity: 1',
    'visibility: visible',
    'transform: none',
    'filter: none',
    'clip-path: none',
    'isolation: isolate',
    'z-index: 100',
  ])
    expect(css).toContain(`${property} !important`)
  expect(css).toContain('--font-body')
})
