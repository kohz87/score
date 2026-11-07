import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { checkStructure } from './structure-check.mjs'

const BASE_MAP = [
  '`apps/web/src/`',
  '`apps/server/src/`',
  '`apps/server/migrations/`',
  '`apps/server/scripts/`',
  '`packages/contract/src/`',
  '`hermes-plugin/score_bridge/`',
  '`scripts/`',
  '`e2e/`',
  '`e2e/readme/`',
].join('\n')

const BASE_FILES = {
  'apps/web/src/main.ts': 'export {}\n',
  'apps/server/src/main.ts': 'export {}\n',
  'apps/server/migrations/0001_init.sql': 'CREATE TABLE example (id INTEGER);\n',
  'apps/server/scripts/tool.ts': 'export {}\n',
  'packages/contract/src/index.ts': 'export {}\n',
  'hermes-plugin/score_bridge/__init__.py': 'HOOKS = ()\n',
  'scripts/tool.mjs': 'export {}\n',
  'e2e/spec.ts': 'export {}\n',
  'e2e/readme/screenshot.spec.ts': 'export {}\n',
}

const roots = []

function lines(count) {
  return 'x\n'.repeat(count)
}

function makeTree({ files = {}, exceptions = [], map = BASE_MAP } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'score-structure-check-'))
  roots.push(root)
  for (const [path, contents] of Object.entries({ ...BASE_FILES, ...files })) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'scripts/size-exceptions.json'), `${JSON.stringify(exceptions)}\n`)
  writeFileSync(join(root, 'docs/CODEMAP.md'), `${map}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('passes a clean tree with a listed oversized file', () => {
  const root = makeTree({
    files: { 'apps/web/src/large.css': lines(451) },
    exceptions: [{ path: 'apps/web/src/large.css', lines: 451, reason: 'split in CS.2 wave 1' }],
  })

  expect(checkStructure(root)).toEqual({
    errors: [],
    exceptionCount: 1,
    folderCount: 9,
  })
})

test('fails when an oversized CSS file is not on the exception list', () => {
  const root = makeTree({ files: { 'apps/web/src/new.css': lines(451) } })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'apps/web/src/new.css is 451 lines (limit 450) and is missing from scripts/size-exceptions.json',
    ),
  ])
})

test('fails when an oversized Python file is not on the exception list', () => {
  const root = makeTree({
    files: { 'hermes-plugin/score_bridge/new.py': lines(451) },
  })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'hermes-plugin/score_bridge/new.py is 451 lines (limit 450) and is missing from scripts/size-exceptions.json',
    ),
  ])
})

test('fails when an oversized plugin test file is not on the exception list', () => {
  const root = makeTree({
    files: { 'hermes-plugin/tests/test_new.py': lines(451) },
  })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'hermes-plugin/tests/test_new.py is 451 lines (limit 450) and is missing from scripts/size-exceptions.json',
    ),
  ])
})

test('fails when a listed file is now at or under the limit', () => {
  const root = makeTree({
    files: { 'apps/web/src/shrunk.css': lines(450) },
    exceptions: [{ path: 'apps/web/src/shrunk.css', lines: 451, reason: 'split in CS.2 wave 1' }],
  })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'apps/web/src/shrunk.css is 450 lines, at or under the 450-line limit. Remove its entry',
    ),
  ])
})

test('fails when a listed file grows past its recorded line count', () => {
  const root = makeTree({
    files: { 'apps/web/src/grew.css': lines(452) },
    exceptions: [{ path: 'apps/web/src/grew.css', lines: 451, reason: 'split in CS.2 wave 1' }],
  })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'apps/web/src/grew.css grew from 451 to 452 lines. The exception list never lets a listed file grow',
    ),
  ])
})

test('fails when a source folder is missing from the code map', () => {
  const root = makeTree({ files: { 'apps/server/src/feature/new.ts': 'export {}\n' } })

  expect(checkStructure(root).errors).toEqual([
    expect.stringContaining(
      'apps/server/src/feature contains source files but is not named in docs/CODEMAP.md',
    ),
  ])
})
