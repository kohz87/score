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
    // `any` and `raised` have no display of their own to assert: raised is lifted above the page like the cards
    // (position and z-index) without changing how it is laid out.
    if (kind === 'any' || kind === 'raised') continue
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

test('glyph shapes are re-asserted too, and the bare glyph svg is not a flex container', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  expect(css).toContain("html[data-look='custom'] [data-protected] svg *")
  expect(css).toContain("svg[data-protected='inline-flex']")
  expect(css).toContain("[data-protected='inline-flex']:not(svg)")
})

test('trusted typography on protected surfaces: spacing, orientation and shadows are re-asserted (re-gate finding 3)', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  for (const declaration of [
    'word-spacing: normal',
    'writing-mode: horizontal-tb',
    'text-shadow: none',
    'translate: none',
    'rotate: none',
    'scale: none',
  ])
    expect(css, declaration).toContain(`${declaration} !important`)
  // Size, line height and the rest sit below the components' own rules: only an inherited value is replaced.
  const base =
    /html\[data-look='custom'\] \[data-protected\] \{[^}]*font-size: var\(--body-size\);[^}]*\}/.exec(
      css,
    )
  expect(base?.[0]).toContain('line-height: 1.5')
  expect(base?.[0]).toContain('letter-spacing: normal')
  expect(base?.[0]).toContain('text-transform: none')
  expect(base?.[0]).toContain('white-space: normal')
  expect(base?.[0]).not.toContain('!important')
})

test('the way back wears an opaque background of its own (re-gate finding 5: a translucent rail over a picture)', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  expect(css).toMatch(
    /\[data-protected='raised'\]:not\(\[aria-current='page'\]\) \{[^}]*background-color: var\(--card\) !important/,
  )
})

// Cross-audit X1: a form that posts a consent can't lose its markers unnoticed. Each of these is one decision
// (`data-decision`) and wears the protected surfaces listed for it; a new consent form is added here.
const consentForms: Record<string, { decisions: number; markers: string[] }> = {
  'routes/orchestrations/NewOrchestrationDialog.tsx': {
    decisions: 1,
    markers: ['orch-workers', 'orch-approvals', 'orch-spend', 'orch-limits', 'orch-start'],
  },
  'routes/workflows/StartWorkflowDialog.tsx': {
    decisions: 1,
    markers: ['orch-approvals', 'orch-spend', 'orch-limits', 'orch-start'],
  },
  'bold/BoldStartJob.tsx': {
    decisions: 1,
    markers: ['bold-start-dialog', 'start-checks', 'start-secret'],
  },
  'routes/team/McpAccessSection.tsx': { decisions: 1, markers: ['team-mcp-access'] },
  'routes/settings/RemoteSection.tsx': { decisions: 1, markers: ['settings-remote'] },
  'routes/pair/PairPage.tsx': { decisions: 1, markers: ['pair-card'] },
  'routes/team/CodingAgent.tsx': { decisions: 1, markers: ['coding-acknowledge'] },
  'bold/BoldAddAgent.tsx': { decisions: 1, markers: ['coding-acknowledge'] },
  'routes/tasks/TaskDrawer.tsx': { decisions: 1, markers: ['task-drawer-approval'] },
  // Not a consent, but the full-screen Customizer's way back (X7).
  'routes/customizer/Customizer.tsx': { decisions: 0, markers: ['cz-back'] },
}

test('every form that posts a consent is a data-decision and wears its protected surfaces', () => {
  const problems: string[] = []
  for (const [file, { decisions, markers }] of Object.entries(consentForms)) {
    const text = readFileSync(join(root, file), 'utf8')
    // The attribute, not a comment's "(data-decision)".
    const found = text.match(/(?<![(\w-])data-decision(?![\w)-])/g)?.length ?? 0
    if (found !== decisions) problems.push(`${file}: ${found} data-decision, expected ${decisions}`)
    for (const marker of markers) {
      if (!(protectedClasses as readonly string[]).includes(marker))
        problems.push(`${file}: ${marker} is not a protected class`)
      const pattern = new RegExp(`className=(?:"|\\{\`)[^"\`]*\\b${marker}(?![\\w-])`)
      const at = pattern.exec(text)
      if (!at) problems.push(`${file}: no element wears ${marker}`)
      else {
        const start = text.lastIndexOf('<', at.index)
        if (!text.slice(Math.max(0, start - 200), at.index + 700).includes('data-protected'))
          problems.push(`${file}: ${marker} is not data-protected`)
      }
    }
  }
  expect(problems).toEqual([])
})

// A pet avatar's stage, animation files and overlay graphics are moved by Score's own CSS (opacity for the crossfade,
// transform for the centring, the hop and the heart). protected.css pins opacity and transform on everything inside a
// protected surface, so it must leave exactly those parts alone: pinned, every cached file would stay on top and the
// centring would be lost (found in review, 10.2b).
test('protected.css leaves a pet avatar’s own moving parts to Score’s rules, and only those', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  const squashed = css.replace(/\s+/g, ' ')
  const rule =
    /\[data-protected\]:not\(svg\) \*:not\(svg \*\)([^{]*)\{ opacity: 1 !important;[^}]*transform: none !important/.exec(
      squashed,
    )
  expect(rule, 'the blanket rule').not.toBeNull()
  // Inside `:where`, so it adds no specificity (the disabled-control rule must still win over this one).
  // (Prettier wraps the list; the whitespace inside the brackets is not part of the selector.)
  expect(rule![1]!.replace(/\( /g, '(').replace(/ \)/g, ')')).toBe(
    ':not(:where(.pet-avatar__stage, .pet-avatar__anim, .pet-avatar__fx, .room-stage__move, .room-stage__anim, .room-stage__fx)) ',
  )
  const pet = readFileSync(join(root, 'components/pet-avatar.css'), 'utf8')
  const moved = new Set<string>()
  for (const [, selector, body] of pet.matchAll(/^\.pet-avatar__([\w-]+)[^{]*\{([^}]*)\}/gm))
    if (/\b(opacity|transform|animation(-name)?):/.test(body!))
      moved.add(selector!.replace(/--.*$/, ''))
  // Every part Score moves is either one of the three exempt classes or an overlay root that carries `fx` (see the
  // PetAvatar test); nothing else may move, or a theme could never be made to leave it alone.
  expect([...moved].sort()).toEqual(['alert', 'anim', 'dot', 'heart', 'say', 'stage', 'z'].sort())
})

// The room stage (PLAN 10.10) moves its own parts the same way: the three exempt classes above are the only ones
// protected.css leaves alone, so every part Score moves must wear one (or sit inside an svg, which the layer never
// pins), and nothing else may move.
test('the room stage’s moving parts are exactly the ones that wear an exempt class or live in an svg', () => {
  const css = readFileSync(join(root, 'routes/chat/stage/room-stage.css'), 'utf8')
  const moved = new Set<string>()
  for (const [, selectors, body] of css.matchAll(/^(\.room-stage[^{]*)\{([^}]*)\}/gm)) {
    if (!/\b(opacity|transform|animation(-name)?):/.test(body!)) continue
    for (const selector of selectors!.split(',')) {
      // The element that moves is the last compound selector's own class.
      const last = selector.trim().split(/\s+/).at(-1)!
      const own = /\.room-stage__([\w]+)/.exec(last)
      if (own) moved.add(own[1]!)
    }
  }
  expect([...moved].sort()).toEqual(['anim', 'bang', 'body', 'dot', 'fig', 'mark', 'say', 'z'])
  const view = readFileSync(join(root, 'routes/chat/stage/RoomStageView.tsx'), 'utf8')
  for (const part of ['body', 'fig', 'mark'])
    expect(view, part).toMatch(new RegExp('room-stage__' + part + '[\'"`,\\s]+room-stage__move'))
  for (const part of ['bang', 'say'])
    expect(view, part).toMatch(new RegExp(`room-stage__fx room-stage__${part}`))
  expect(view).toContain('room-stage__anim')
})

test('the room stage is a protected surface a theme cannot name, and its markup says so', () => {
  expect(protectedClasses).toContain('room-stage')
  const view = readFileSync(join(root, 'routes/chat/stage/RoomStageView.tsx'), 'utf8')
  expect(view).toMatch(/className=\{`room-stage[^`]*`\}[\s\S]{0,300}data-protected="any"/)
})
