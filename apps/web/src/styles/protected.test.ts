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
    !['chat-toast', 'agent-glyph', 'look-reset', 'security-password', 'team-permissions'].includes(
      name,
    ) && !name.startsWith('look-banner'),
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

type Spec = readonly [number, number, number]

type ParsedRule = {
  /** Rule order in the sheet, including rules nested in @media/@layer blocks. */
  order: number
  selector: string
  /** Whether the rule sits inside `prefers-color-scheme: dark`. */
  darkMedia: boolean
}

type GroupRule = CSSRule & { cssRules: CSSRuleList; conditionText?: string }
type StyleRule = CSSRule & { selectorText: string; style: CSSStyleDeclaration }

const isGroupRule = (rule: CSSRule): rule is GroupRule => 'cssRules' in rule
const isStyleRule = (rule: CSSRule): rule is StyleRule => 'selectorText' in rule && 'style' in rule

/** The rules of a stylesheet, flattened depth-first so their source order survives @layer and @media. */
function parsedRules(css: string): ParsedRule[] {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const found: ParsedRule[] = []
  let order = 0
  const walk = (rules: CSSRuleList, darkMedia: boolean) => {
    for (const rule of Array.from(rules)) {
      order += 1
      if (isStyleRule(rule)) {
        found.push({ order, selector: rule.selectorText, darkMedia })
        continue
      }
      if (isGroupRule(rule))
        walk(
          rule.cssRules,
          darkMedia ||
            (rule instanceof CSSMediaRule &&
              rule.conditionText.includes('prefers-color-scheme: dark')),
        )
    }
  }
  walk(style.sheet!.cssRules, false)
  style.remove()
  return found
}

const add = (a: Spec, b: Spec): Spec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

const compare = (a: Spec, b: Spec): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function splitSelectorList(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

function maxSpecificity(selector: string): Spec {
  return splitSelectorList(selector).reduce<Spec>(
    (best, part) => (compare(specificityOf(part), best) > 0 ? specificityOf(part) : best),
    [0, 0, 0],
  )
}

/** The index of the `close` matching `open` at `start`, skipping quotes and nested brackets/parentheses. */
function matching(selector: string, start: number, open: string, close: string): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < selector.length; i++) {
    const ch = selector[i]!
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return i
  }
  return selector.length
}

/** Enough of CSS specificity for protected.css: :where is zero, :not/:is/:has take their argument's maximum. */
function specificityOf(selector: string): Spec {
  let spec: Spec = [0, 0, 0]
  for (let i = 0; i < selector.length;) {
    const ch = selector[i]!
    if (ch === '#' || ch === '.') {
      spec = add(spec, ch === '#' ? [1, 0, 0] : [0, 1, 0])
      i++
      while (/[\w-]/.test(selector[i] ?? '')) i++
    } else if (ch === '[') {
      spec = add(spec, [0, 1, 0])
      i = matching(selector, i, '[', ']') + 1
    } else if (ch === ':') {
      const element = selector[i + 1] === ':'
      let j = i + (element ? 2 : 1)
      const nameStart = j
      while (/[\w-]/.test(selector[j] ?? '')) j++
      const name = selector.slice(nameStart, j).toLowerCase()
      if (selector[j] === '(') {
        const end = matching(selector, j, '(', ')')
        const args = selector.slice(j + 1, end)
        if (name === 'is' || name === 'not' || name === 'has')
          spec = add(spec, maxSpecificity(args))
        else if (name !== 'where') spec = add(spec, element ? [0, 0, 1] : [0, 1, 0])
        i = end + 1
      } else {
        if (!name.startsWith('where')) spec = add(spec, element ? [0, 0, 1] : [0, 1, 0])
        i = j
      }
    } else if (/[A-Za-z]/.test(ch)) {
      spec = add(spec, [0, 0, 1])
      i++
      while (/[\w-]/.test(selector[i] ?? '')) i++
    } else {
      i++
    }
  }
  return spec
}

test('the bold fallback follows the shell’s data-look, not the page’s data-theme', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8').replace(/\s+/g, ' ')
  for (const mode of ['light', 'dark'] as const) {
    const rule = new RegExp(
      `html\\[data-contrast-fallback\\]\\[data-contrast-fallback\\] \\[data-ui='bold'\\]\\[data-look='${mode}'\\] \\[data-protected\\]`,
    )
    expect(css, mode).toMatch(rule)
    expect(css, `${mode} decision`).toContain(
      `[data-ui='bold'][data-look='${mode}'] [data-decision]`,
    )
  }
  // Search's switch changes data-look only: keying the bold fallback on data-theme would miss it.
  expect(css).not.toMatch(
    /html\[data-contrast-fallback\]\[data-theme='(light|dark)'\] \[data-ui='bold'\]/,
  )
})

test('the bold fallback comes after the system-dark copy and out-specifies it', () => {
  const rules = parsedRules(readFileSync(join(root, 'styles/protected.css'), 'utf8'))
  const systemDark = rules.filter(
    (rule) =>
      rule.darkMedia &&
      rule.selector
        .replace(/\s+/g, ' ')
        .includes('html[data-contrast-fallback]:not([data-theme])') &&
      rule.selector.replace(/\s+/g, ' ').includes('[data-protected]'),
  )
  const bold = ['light', 'dark'].flatMap((mode) =>
    rules.filter((rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ')
      return (
        selector.includes(
          `html[data-contrast-fallback][data-contrast-fallback] [data-ui='bold'][data-look='${mode}']`,
        ) && selector.includes('[data-protected]')
      )
    }),
  )
  expect(systemDark).toHaveLength(2)
  expect(bold).toHaveLength(2)
  for (const rule of bold) {
    const specificity = maxSpecificity(rule.selector)
    for (const dark of systemDark) {
      expect(rule.order, rule.selector).toBeGreaterThan(dark.order)
      expect(compare(specificity, maxSpecificity(dark.selector))).toBeGreaterThan(0)
    }
  }
  // The privacy rule is after the media block too, and its doubled attribute keeps it on the shell's ground.
  const privacy = rules.find((rule) =>
    rule.selector.replace(/\s+/g, ' ').includes('.bold-dm-privacy[data-protected]'),
  )
  expect(privacy).toBeDefined()
  expect(privacy!.order).toBeGreaterThan(Math.max(...systemDark.map((rule) => rule.order)))
  expect(privacy!.selector.replace(/\s+/g, ' ')).toContain(
    "html[data-contrast-fallback][data-contrast-fallback] [data-ui='bold']",
  )
})

test('glyph shapes are re-asserted too, and the bare glyph svg is not a flex container', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  expect(css).toContain("html[data-look='custom'] [data-protected] svg *")
  expect(css).toContain("svg[data-protected='inline-flex']")
  expect(css).toContain("[data-protected='inline-flex']:not(svg)")
})

test('a glyph\u2019s eyes cannot be hidden or painted in the body colour (decision 127)', () => {
  const css = readFileSync(join(root, 'styles/protected.css'), 'utf8')
  expect(css).toMatch(
    /\.agent-face__socket \{[^}]*display: inline !important;[^}]*fill: #fff !important/,
  )
  expect(css).toMatch(/\.agent-face__arc \{[^}]*stroke: #fff !important/)
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
    markers: [
      'bold-start-dialog',
      'start-checks',
      'start-secret',
      'start-limits',
      'start-ask',
      'start-more',
    ],
  },
  'routes/settings/RemoteSection.tsx': { decisions: 1, markers: ['settings-remote'] },
  'routes/pair/PairPage.tsx': { decisions: 1, markers: ['pair-card'] },
  'routes/team/CodingAgent.tsx': { decisions: 1, markers: ['coding-acknowledge'] },
  'bold/BoldAddAgent.tsx': { decisions: 1, markers: ['coding-acknowledge'] },
  // Not a consent, but the Customizer's way back to Look (X7).
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
