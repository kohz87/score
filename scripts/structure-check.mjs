#!/usr/bin/env node
// Enforces the 450-line limit's exception list and keeps every source folder named in docs/CODEMAP.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 450
const EXCEPTIONS_PATH = 'scripts/size-exceptions.json'
const CODEMAP_PATH = 'docs/CODEMAP.md'
const SOURCE_ROOTS = [
  'apps/web/src',
  'apps/server/src',
  'apps/server/migrations',
  'apps/server/scripts',
  'packages/contract/src',
  'hermes-plugin/score_bridge',
  'scripts',
  'e2e',
]
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.css', '.py', '.sql', '.sh'])
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.venv', '__pycache__'])

const asPosix = (path) => path.split(sep).join('/')

/** Counts lines exactly as ESLint's max-lines rule does, including blank and comment lines. */
export function countLines(text) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines.length
}

function walkFiles(path, files = []) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) walkFiles(child, files)
    else if (entry.isFile()) files.push(child)
  }
  return files
}

function sourceFolders(root) {
  const folders = new Set()
  for (const sourceRoot of SOURCE_ROOTS) {
    const absolute = join(root, sourceRoot)
    if (!existsSync(absolute)) continue
    const visit = (path) => {
      const entries = readdirSync(path, { withFileTypes: true })
      if (entries.some((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)))) {
        folders.add(asPosix(relative(root, path)))
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) {
          continue
        }
        visit(join(path, entry.name))
      }
    }
    visit(absolute)
  }
  return [...folders].sort()
}

function readExceptions(root, errors) {
  const path = join(root, EXCEPTIONS_PATH)
  try {
    const entries = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(entries)) throw new Error('the file must contain an array')
    return entries.filter((entry, index) => {
      if (
        typeof entry?.path !== 'string' ||
        typeof entry?.lines !== 'number' ||
        typeof entry?.reason !== 'string'
      ) {
        errors.push(`${EXCEPTIONS_PATH} entry ${index + 1} needs a path, line count and reason.`)
        return false
      }
      return true
    })
  } catch (error) {
    errors.push(`Cannot read ${EXCEPTIONS_PATH}: ${error instanceof Error ? error.message : error}`)
    return []
  }
}

function mappedPaths(root, errors) {
  const path = join(root, CODEMAP_PATH)
  try {
    const map = readFileSync(path, 'utf8')
    return new Set(
      [...map.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim().replace(/\/+$/, '')),
    )
  } catch (error) {
    errors.push(`Cannot read ${CODEMAP_PATH}: ${error instanceof Error ? error.message : error}`)
    return new Set()
  }
}

function oversizedSources(root) {
  const files = [
    ...walkFiles(join(root, 'apps')).filter(
      (path) => path.endsWith('.css') && asPosix(relative(root, path)).split('/').includes('src'),
    ),
    // All of the plugin's Python, its tests included (test_review_regressions.py once slipped past a score_bridge-only walk).
    ...walkFiles(join(root, 'hermes-plugin')).filter((path) => path.endsWith('.py')),
  ]

  return [...new Set(files)].map((path) => ({
    path: asPosix(relative(root, path)),
    lines: countLines(readFileSync(path, 'utf8')),
  }))
}

export function checkStructure(root = process.cwd()) {
  const errors = []
  const exceptions = readExceptions(root, errors)
  const exceptionLines = new Map(exceptions.map((entry) => [entry.path, entry.lines]))
  // A path listed twice (a merge can leave one) would let two ceilings disagree.
  const seen = new Set()
  for (const entry of exceptions) {
    if (seen.has(entry.path)) errors.push(`${entry.path} is listed twice in ${EXCEPTIONS_PATH}.`)
    seen.add(entry.path)
  }

  for (const source of oversizedSources(root)) {
    if (source.lines <= LIMIT || exceptionLines.has(source.path)) continue
    errors.push(
      `${source.path} is ${source.lines} lines (limit ${LIMIT}) and is missing from ${EXCEPTIONS_PATH}. ` +
        'Split it into files of 450 lines or fewer, or add it with a reason and its current line count.',
    )
  }

  for (const entry of exceptions) {
    const path = join(root, entry.path)
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(
        `${entry.path} is listed in ${EXCEPTIONS_PATH} but no longer exists. ` +
          'Remove its entry; the exception list only shrinks.',
      )
      continue
    }
    const lines = countLines(readFileSync(path, 'utf8'))
    if (lines <= LIMIT) {
      errors.push(
        `${entry.path} is ${lines} lines, at or under the ${LIMIT}-line limit. ` +
          `Remove its entry from ${EXCEPTIONS_PATH}; the exception list only shrinks.`,
      )
    } else if (lines > entry.lines) {
      errors.push(
        `${entry.path} grew from ${entry.lines} to ${lines} lines. ` +
          `The exception list never lets a listed file grow: split it back to ${entry.lines} lines or fewer.`,
      )
    }
  }

  const folders = sourceFolders(root)
  const mapped = mappedPaths(root, errors)
  for (const folder of folders) {
    if (mapped.has(folder)) continue
    errors.push(
      `${folder} contains source files but is not named in ${CODEMAP_PATH}. ` +
        'Add a folder line for it.',
    )
  }

  return { errors, exceptionCount: exceptions.length, folderCount: folders.length }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const root = process.argv[2] ? resolve(process.argv[2]) : process.cwd()
  const result = checkStructure(root)
  if (result.errors.length) {
    console.error(`Structure check FAILED (${result.errors.length}):`)
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exitCode = 1
  } else {
    console.log(
      `Structure check passed: ${result.exceptionCount} size exceptions, ` +
        `${result.folderCount} source folders mapped.`,
    )
  }
}
