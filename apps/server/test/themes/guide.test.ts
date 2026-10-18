import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { THEME_COLOR_TOKENS, ThemeManifestSchema } from '@score/contract'

// docs/THEMES.md documents every manifest field and every colour token. This compares the page with the schema, so a
// field added to (or dropped from) packages/contract/src/themes.ts without a matching row in the guide fails here.
const root = join(import.meta.dirname, '../../../..')
const guide = readFileSync(join(root, 'docs/THEMES.md'), 'utf8')

function section(name: string): string {
  const start = guide.indexOf(`<!-- ${name}:start -->`)
  const end = guide.indexOf(`<!-- ${name}:end -->`)
  expect(start, `${name} section`).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return guide.slice(start, end)
}

/** `| \`first\` | second | third |` rows of a markdown table, by their first cell. */
function rows(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line)
    if (match) out.set(match[1]!, match[2]!)
  }
  return out
}

type Node = {
  type?: string
  properties?: Record<string, Node>
  items?: Node
  enum?: unknown[]
  anyOf?: Node[]
  minimum?: number
  maximum?: number
  propertyNames?: { enum?: unknown[] }
}

/** Every field path of the manifest's JSON Schema (arrays as `path[]`), with the node that describes it. */
function fields(): Map<string, Node> {
  const out = new Map<string, Node>()
  const walk = (node: Node, path: string) => {
    if (path) out.set(path, node)
    if (node.properties)
      for (const [key, child] of Object.entries(node.properties))
        walk(child, path ? `${path}.${key}` : key)
    if (node.items) walk(node.items, `${path}[]`)
  }
  walk(z.toJSONSchema(ThemeManifestSchema, { io: 'input' }) as Node, '')
  return out
}

/** The literal values a field allows, and its numeric bounds, for the guide to name. */
function allowed(node: Node): { values: string[]; numbers: number[] } {
  const parts = [node, ...(node.anyOf ?? [])]
  return {
    values: parts.flatMap((part) => (part.enum ?? []).map(String)),
    numbers: parts.flatMap((part) => [part.minimum, part.maximum]).filter((n) => n !== undefined),
  }
}

describe('docs/THEMES.md manifest fields', () => {
  const documented = rows(section('fields'))
  const all = fields()
  // `views.user` takes every look field; the guide has one row for it.
  const own = new Map([...all].filter(([path]) => !path.startsWith('views.user.')))

  test('has a row for every field of the schema, and no row for a field that isn’t there', () => {
    expect([...documented.keys()].sort()).toEqual([...own.keys()].sort())
  })

  test('views.user takes exactly the look fields the guide lists', () => {
    const looks = [...own.keys()].filter(
      (path) =>
        !['format', 'id', 'name', 'version', 'author', 'description', 'views'].includes(
          path.split(/[.[]/)[0]!,
        ) && !path.startsWith('views'),
    )
    const nested = [...all.keys()]
      .filter((path) => path.startsWith('views.user.'))
      .map((path) => path.slice('views.user.'.length))
    expect(nested.sort()).toEqual(looks.sort())
  })

  test.each([...own])('%s names its allowed values', (path, node) => {
    const row = documented.get(path)
    expect(row, path).toBeDefined()
    const { values, numbers } = allowed(node)
    // Colour sets list their tokens in their own table.
    if (path === 'colors.light' || path === 'colors.dark') return
    for (const value of values) expect(row, `${path}: ${value}`).toContain(`\`${value}\``)
    for (const n of numbers)
      expect(row, `${path}: ${n}`).toMatch(new RegExp(`(^|[^0-9])${n}([^0-9]|$)`))
  })
})

describe('docs/THEMES.md colour tokens', () => {
  test('lists exactly the tokens the manifest accepts', () => {
    expect([...rows(section('tokens')).keys()].sort()).toEqual([...THEME_COLOR_TOKENS].sort())
  })
})

describe('the example in docs/THEMES.md', () => {
  test('is the theme.json of docs/themes/example-theme, and valid', () => {
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]!)
    const file = JSON.parse(
      readFileSync(join(root, 'docs/themes/example-theme/theme.json'), 'utf8'),
    )
    expect(ThemeManifestSchema.safeParse(file).success).toBe(true)
    expect(blocks.some((block) => JSON.stringify(JSON.parse(block)) === JSON.stringify(file))).toBe(
      true,
    )
  })
})
