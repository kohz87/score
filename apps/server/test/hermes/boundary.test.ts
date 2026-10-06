import { ESLint } from 'eslint'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const serverRoot = fileURLToPath(new URL('../../', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const forbiddenFragments = [
  '/v1/runs',
  '/v1/capabilities',
  '/p/{',
  '.hermes',
  'kanban.db',
  'state.db',
  'HERMES_',
  'hermes kanban',
  'API_SERVER_KEY',
]
const upstreamEvents = [
  'approval.request',
  'tool.started',
  'tool.completed',
  'message.interim',
  'reasoning.available',
  'run.completed',
]
// Escaped literals keep the scanner's own source free of the names it prohibits.
const personaPattern = /\u0061keno|\u0066ern|\u006dakima|\u006darin/i

function boundaryViolations(source: string): string[] {
  return [
    ...forbiddenFragments.filter((fragment) => source.includes(fragment)),
    ...upstreamEvents.filter((event) =>
      ["'", '"', '`'].some((quote) => source.includes(`${quote}${event}${quote}`)),
    ),
  ]
}

function tsFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

test('server modules outside the adapter contain no upstream boundary details', () => {
  const violations = tsFiles(join(serverRoot, 'src'))
    .filter((path) => !relative(join(serverRoot, 'src'), path).startsWith('hermes/'))
    .flatMap((path) =>
      boundaryViolations(readFileSync(path, 'utf8')).map((item) => `${path}: ${item}`),
    )
  expect(violations).toEqual([])
})

test.each(forbiddenFragments)('boundary scanner catches planted fragment %s', (fragment) => {
  expect(boundaryViolations(`const detail = '${fragment}'`)).toContain(fragment)
})

test.each(upstreamEvents)('boundary scanner catches the whole quoted token %s', (event) => {
  for (const quote of ["'", '"', '`']) {
    expect(boundaryViolations(`const type = ${quote}${event}${quote}`)).toContain(event)
    expect(boundaryViolations(`const type = ${quote}${event}ed${quote}`)).toEqual([])
  }
})

test('Score approval.requested does not trip the upstream token check', () => {
  expect(boundaryViolations("const type = 'approval.requested'")).toEqual([])
})

test('server sources and tests use neutral example agents only', () => {
  const violations = [
    ...tsFiles(join(serverRoot, 'src')),
    ...tsFiles(join(serverRoot, 'test')),
  ].filter((path) => personaPattern.test(readFileSync(path, 'utf8')))
  expect(violations).toEqual([])
})

test('the neutral-agent scanner catches planted names in any case', () => {
  for (const name of ['\u0061keno', '\u0066ern', '\u006dakima', '\u006darin']) {
    expect(personaPattern.test(name)).toBe(true)
    expect(personaPattern.test(name.toUpperCase())).toBe(true)
  }
})

test.each([
  ['../hermes/fake/fake-port.ts', false],
  ['./hermes/port.ts', false],
  ['../../hermes/live/live-port.ts', false],
  ['../hermes', false],
  ['../hermes/index.ts/internal.ts', false],
  ['../hermes/index.ts', true],
  ['./hermes/index.ts', true],
  ['../../hermes/index.ts', true],
])('ESLint enforces the adapter entry for %s', async (specifier, allowed) => {
  const eslint = new ESLint({ cwd: repoRoot })
  const [result] = await eslint.lintText(`export { value } from '${specifier}'\n`, {
    filePath: join(serverRoot, 'src/http/boundary-probe.ts'),
  })
  const violations = result!.messages.filter(
    (message) => message.ruleId === 'no-restricted-imports',
  )
  expect(violations).toHaveLength(allowed ? 0 : 1)
})

test('ESLint permits internal imports within the adapter', async () => {
  const eslint = new ESLint({ cwd: repoRoot })
  const [result] = await eslint.lintText("export { value } from '../port.ts'\n", {
    filePath: join(serverRoot, 'src/hermes/fake/boundary-probe.ts'),
  })
  expect(result!.messages).toEqual([])
})
