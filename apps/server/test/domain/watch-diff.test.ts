import { expect, test } from 'vitest'
import {
  editorFrameFromTool,
  editorFramesFromTool,
  type EditorFrame,
} from '../../src/domain/watch-diff.ts'

function single(
  tool: string,
  args: unknown,
  result: unknown = null,
  previous?: string | null,
): EditorFrame {
  const frame = editorFrameFromTool(tool, args, result, previous)
  if (!frame || Array.isArray(frame)) throw new Error('Expected one editor payload')
  return frame
}

const patch = (text: string) => ({ mode: 'patch', patch: text })
const replace = { path: 'src/main.ts', old_string: 'old', new_string: 'new' }

test.each([
  {
    name: 'unknown previous',
    content: 'new\n',
    previous: undefined,
    body: '@@ -0,0 +1,1 @@\n+new\n',
  },
  { name: 'null previous', content: 'new\n', previous: null, body: '@@ -0,0 +1,1 @@\n+new\n' },
  { name: 'known empty file', content: 'new\n', previous: '', body: '@@ -0,0 +1,1 @@\n+new\n' },
  {
    name: 'replacement',
    content: 'new\n',
    previous: 'old\n',
    body: '@@ -1,1 +1,1 @@\n-old\n+new\n',
  },
  { name: 'deletion', content: '', previous: 'old\n', body: '@@ -1,1 +0,0 @@\n-old\n' },
  { name: 'CRLF', content: 'new\r\n', previous: 'old\r\n', body: '@@ -1,1 +1,1 @@\n-old\n+new\n' },
  {
    name: 'no final newline',
    content: 'new',
    previous: '',
    body: '@@ -0,0 +1,1 @@\n+new\n\\ No newline at end of file\n',
  },
])('write_file: $name', ({ content, previous, body }) => {
  expect(single('write_file', { path: 'src/main.ts', content }, {}, previous)).toEqual({
    path: 'src/main.ts',
    language: 'typescript',
    diff: '--- src/main.ts\n+++ src/main.ts\n' + body,
  })
})

test.each(['', 'unchanged\n', 'unchanged\r\n'])(
  'unchanged write has an empty diff: %j',
  (content) => {
    expect(single('write_file', { path: 'notes.txt', content }, null, content).diff).toBe('')
  },
)

test.each([
  ['src/index.TSX', 'typescript'],
  ['main.py', 'python'],
  ['data.json', 'json'],
  ['README.md', 'markdown'],
  ['config.yml', 'yaml'],
  ['config.toml', 'toml'],
  ['run.sh', 'bash'],
  ['styles.css', 'css'],
  ['index.html', 'html'],
  ['query.sql', 'sql'],
  ['main.rs', 'rust'],
  ['main.go', 'go'],
  ['app.jsx', 'javascript'],
  ['app.mjs', 'javascript'],
  ['README', null],
  ['folder.ts/file', null],
  ['C:\\src\\main.ts', 'typescript'],
  ['data.bin', null],
  ['data.constructor', null],
  ['data.__proto__', null],
])('language for %s is %s', (path, language) => {
  expect(single('write_file', { path, content: 'text' }).language).toBe(language)
})

test('find/replace without a baseline labels fragment coordinates', () => {
  expect(single('patch', replace).diff).toBe(
    [
      '--- src/main.ts',
      '+++ src/main.ts',
      '@@ -1,1 +1,1 @@ fragment (file position unknown)',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n'),
  )
})

test.each([undefined, 'replace'])(
  'find/replace mode %s locates the edit in previous content',
  (mode) => {
    const frame = single('patch', { ...replace, mode }, {}, 'first\nold\nlast\n')
    expect(frame.diff).toContain('@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n')
    expect(frame.diff).not.toContain('fragment')
  },
)

test('find/replace supports replace_all, deletion and CRLF', () => {
  expect(single('patch', { ...replace, replace_all: true }, {}, 'old\nold\n').diff).toContain(
    '-old\n-old\n+new\n+new\n',
  )
  expect(single('patch', { ...replace, new_string: '' }, {}, 'old').diff).toContain(
    '@@ -1,1 +0,0 @@\n-old\n\\ No newline at end of file\n',
  )
  expect(
    single('patch', { path: 'x', old_string: 'old\r\n', new_string: 'new\r\n' }, {}, 'old\r\n')
      .diff,
  ).toContain('-old\n+new\n')
})

test.each(['unrelated\n', 'old\nold\n', 'oldold'])(
  'unmatched or ambiguous replacement is rejected: %j',
  (previous) => {
    expect(editorFrameFromTool('patch', replace, null, previous)).toBeNull()
  },
)

test.each([
  [
    'with wrapper',
    '*** Begin Patch\n*** Update File: src/main.ts\n@@ function main @@\n-old\n+new\n*** End Patch',
  ],
  ['without wrapper or hunk marker', '*** Update File: src/main.ts\n-old\n+new'],
  ['implicit context', '*** Update File: src/main.ts\nfirst\n-old\n+new\nlast'],
  [
    'CRLF',
    '*** Begin Patch\r\n*** Update File: src/main.ts\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n',
  ],
])('V4A update %s', (_, text) => {
  const frame = single('patch', patch(text), {}, 'first\nold\nlast\n')
  expect(frame.diff).toBe(
    '--- src/main.ts\n+++ src/main.ts\n@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n',
  )
})

test('V4A without previous content preserves separate edit fragments', () => {
  const frame = single(
    'patch',
    patch('*** Update File: src/main.ts\n@@ first @@\n-old\n+new\n@@ second @@\n-before\n+after'),
  )
  expect(frame.diff.match(/^@@/gm)).toHaveLength(2)
  expect(frame.diff).toContain('-old\n')
  expect(frame.diff).toContain('+after\n')
  expect(frame.diff.match(/file position unknown/g)).toHaveLength(2)
})

test('V4A later hunks see earlier changes', () => {
  const frame = single(
    'patch',
    patch('*** Update File: x\n@@\n-old\n+middle\n@@\n-middle\n+new'),
    {},
    'old\n',
  )
  expect(frame.diff).toContain('-old\n+new\n')
  expect(frame.diff).not.toContain('middle')
})

test.each([
  [
    '*** Add File: src/new.py\n+one\n+two',
    undefined,
    'src/new.py',
    '--- /dev/null\n+++ src/new.py\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
  ],
  ['*** Add File: empty.txt', undefined, 'empty.txt', '--- /dev/null\n+++ empty.txt\n'],
  [
    '*** Delete File: src/old.py',
    'one\ntwo\n',
    'src/old.py',
    '--- src/old.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n',
  ],
  [
    '*** Delete File: unknown.txt',
    undefined,
    'unknown.txt',
    '--- unknown.txt\n+++ /dev/null\n# Previous content unavailable\n',
  ],
  [
    '*** Move File: old.py -> new.py',
    undefined,
    'new.py',
    'diff --git old.py new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n',
  ],
])('V4A operation %s', (text, previous, path, diff) => {
  expect(single('patch', patch(text!), null, previous).path).toBe(path)
  expect(single('patch', patch(text!), null, previous).diff).toBe(diff)
})

test.each([
  ['*** Update File: x\n@@ anchor @@\n+inserted', 'anchor\ntail\n', 'anchor\ninserted\ntail\n'],
  ['*** Update File: x\n@@ anchor @@\n+inserted', 'anchor', 'anchor\ninserted'],
  ['*** Update File: x\n@@\n+inserted', 'tail\n', 'tail\ninserted\n'],
])('V4A addition-only hunk %s', (text, previous, after) => {
  const frame = single('patch', patch(text), {}, previous)
  expect(addedContent(frame.diff)).toBe(after)
})

function addedContent(diff: string): string {
  const lines = diff.split('\n').slice(2)
  let result = ''
  for (const line of lines) {
    if (line.startsWith('+') || line.startsWith(' ')) result += line.slice(1) + '\n'
    else if (line === '\\ No newline at end of file' && result.endsWith('\n'))
      result = result.slice(0, -1)
  }
  return result
}

test('multi-file V4A returns one payload per file and does not share a baseline', () => {
  const text =
    '*** Begin Patch\n*** Update File: x.ts\n-old\n+new\n*** Add File: y.py\n+text\n*** Delete File: z.txt\n*** Move File: old.md -> new.md\n*** End Patch'
  const result = editorFrameFromTool('patch', patch(text), {}, 'unrelated baseline')
  expect(Array.isArray(result)).toBe(true)
  if (!Array.isArray(result)) throw new Error('Expected several editor payloads')
  expect(result.map((frame) => frame.path)).toEqual(['x.ts', 'y.py', 'z.txt', 'new.md'])
  expect(result[0]!.diff).toContain('fragment')
  expect(result.some((frame) => frame.diff.includes('unrelated baseline'))).toBe(false)
})

test('repeated operations on one path return one payload', () => {
  const frame = single(
    'patch',
    patch('*** Update File: x\n-old\n+new\n*** Update File: x\n-before\n+after'),
  )
  expect(frame.diff).toContain('-old\n')
  expect(frame.diff).toContain('-before\n')
})

test('different operations on one path retain their headers', () => {
  const frame = single('patch', patch('*** Delete File: x\n*** Add File: x\n+new'))
  expect(frame.diff).toContain('--- x\n+++ /dev/null\n# Previous content unavailable\n')
  expect(frame.diff).toContain('--- /dev/null\n+++ x\n@@ -0,0 +1,1 @@\n+new\n')
})

const unified =
  '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -2,2 +2,2 @@ section\n-old\n+new\n context\n'
test.each([
  ['plain', unified],
  ['CRLF', unified.replace(/\n/g, '\r\n')],
  ['git metadata', 'diff --git a/src/main.ts b/src/main.ts\nindex abc..def 100644\n' + unified],
  [
    'timestamps',
    unified
      .replace('a/src/main.ts\n', 'a/src/main.ts\t2026-10-08\n')
      .replace('b/src/main.ts\n', 'b/src/main.ts\t2026-10-08\n'),
  ],
  [
    'quoted paths',
    unified.replace('a/src/main.ts', '"a/src/main.ts"').replace('b/src/main.ts', '"b/src/main.ts"'),
  ],
])('unified patch %s', (_, text) => {
  const frame = single('patch', patch(text))
  expect(frame.path).toBe('src/main.ts')
  expect(frame.diff).toBe(unified.replace('--- a/', '--- ').replace('+++ b/', '+++ '))
})

test('headerless unified hunks require an explicit path', () => {
  const text = '@@ -1 +1 @@\n-old\n+new\n'
  expect(single('patch', { ...patch(text), path: 'file.txt' }).diff).toBe(
    '--- file.txt\n+++ file.txt\n' + text,
  )
  expect(editorFrameFromTool('patch', patch(text), null)).toBeNull()
})

test('unified multi-file creation and deletion keep dev/null headers', () => {
  const text =
    '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+text\n--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'
  const result = editorFrameFromTool('patch', patch(text), {})
  expect(result).toEqual([
    {
      path: 'new.ts',
      language: 'typescript',
      diff: '--- /dev/null\n+++ new.ts\n@@ -0,0 +1 @@\n+text\n',
    },
    {
      path: 'old.py',
      language: 'python',
      diff: '--- old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
    },
  ])
})

test('unified parsing handles header-like content and no-final-newline markers', () => {
  const text =
    '--- a/file\n+++ b/file\n@@ -1 +1 @@\n--- old content\n\\ No newline at end of file\n+++ new content\n\\ No newline at end of file\n'
  expect(single('patch', patch(text)).diff).toContain(
    '--- old content\n\\ No newline at end of file\n+++ new content',
  )
})

test.each([false, true])('valid result diff supplies actual coordinates, JSON=%s', (json) => {
  const result = { success: true, diff: unified }
  const frame = single(
    'patch',
    replace,
    json ? JSON.stringify(result) : result,
    'baseline does not match',
  )
  expect(frame.diff).toContain('@@ -2,2 +2,2 @@ section')
})

test('non-unified result annotations fall back to patch args', () => {
  expect(
    single('patch', patch('*** Add File: x\n+text'), {
      success: true,
      diff: '--- /dev/null\n+++ b/x\n+text',
    }).diff,
  ).toContain('@@ -0,0 +1,1 @@')
})

test.each([
  null,
  undefined,
  [],
  42,
  'text',
  {},
  { path: 1, content: 'text' },
  { path: '', content: 'text' },
  { path: 'file\nother', content: 'text' },
  { path: 'file', content: null },
  { path: 'file', content: {} },
  { path: 'file', content: '\u0000binary' },
  { path: 'file', content: '\u0001binary' },
  { path: 'file', content: '\ud800' },
  { path: 'x'.repeat(4097), content: 'text' },
])('malformed write args return null: %j', (args) => {
  expect(editorFrameFromTool('write_file', args, null)).toBeNull()
})

test.each([
  {},
  { ...replace, mode: 'unknown' },
  { ...replace, old_string: '' },
  { ...replace, new_string: null },
  { ...replace, replace_all: 'yes' },
  { ...replace, old_string: '\u0000' },
  patch('\u0000binary'),
  patch('nonsense'),
  patch('*** Update File: x'),
  patch('*** Move File: x'),
  patch('*** Add File: x\n-text'),
  patch('*** Update File: x\n-old\n+new\n*** End Patch\ntrailing'),
  patch('--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n-a\n+b\n'),
  patch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n-b\n+c\n'),
  patch('--- a/x\n+++ b/x\n@@ -99999999999999999 +1 @@\n-a\n+b\n'),
  patch('--- "invalid quote\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'),
])('malformed patch args return null: %j', (args) => {
  expect(editorFrameFromTool('patch', args, null)).toBeNull()
})

test.each(['read_file', 'terminal', 'search_files', 'unknown'])(
  '%s produces no editor frame',
  (tool) => {
    expect(editorFrameFromTool(tool, { path: 'file', content: 'text' }, {})).toBeNull()
  },
)

test.each([
  42,
  [],
  'not json',
  '{',
  { success: 'yes' },
  { diff: 1 },
  { error: 'failed' },
  { success: false },
  { no_change: true },
])('malformed or failed result returns null: %j', (result) => {
  expect(editorFrameFromTool('write_file', { path: 'file', content: 'text' }, result)).toBeNull()
})

test('binary previous content and hostile input getters never throw', () => {
  expect(
    editorFrameFromTool('write_file', { path: 'file', content: 'text' }, null, 'old\u0000'),
  ).toBeNull()
  expect(
    editorFrameFromTool(
      'write_file',
      {
        get path() {
          throw new Error('getter')
        },
      },
      null,
    ),
  ).toBeNull()
})

test('huge write is capped at whole hunks with an exact omitted line count', () => {
  const frame = single('write_file', { path: 'file', content: 'é🙂'.repeat(50_000) + '\n' })
  expect(frame.diff).toBe('--- file\n+++ file\n… 2 more lines\n')
  expect(Buffer.byteLength(frame.diff)).toBeLessThanOrEqual(65536)
})

test('cap retains fitting hunks and counts all remaining hunk lines', () => {
  const first = '@@ -1 +1 @@\n-old\n+new\n'
  const large = '@@ -10,0 +10,2 @@\n+' + '🙂'.repeat(17_000) + '\n+last\n'
  const frame = single('patch', patch('--- a/file\n+++ b/file\n' + first + large))
  expect(frame.diff).toBe('--- file\n+++ file\n' + first + '… 3 more lines\n')
  expect(Buffer.byteLength(frame.diff)).toBeLessThanOrEqual(65536)
})

test('large unrelated writes and many small lines stay under the UTF-8 cap', () => {
  const oldText = Array.from({ length: 20_000 }, (_, i) => `old ${i}`).join('\n') + '\n'
  const content = Array.from({ length: 20_000 }, (_, i) => `new ${i}`).join('\n') + '\n'
  const frame = single('write_file', { path: 'file', content }, {}, oldText)
  expect(frame.diff).toBe('--- file\n+++ file\n… 40001 more lines\n')
  expect(Buffer.byteLength(frame.diff)).toBeLessThanOrEqual(65536)
})

test('exact byte boundary includes the complete hunk', () => {
  const frame = single('write_file', { path: 'file', content: 'x'.repeat(65536 - 36) + '\n' })
  expect(Buffer.byteLength(frame.diff)).toBe(65536)
  expect(frame.diff).not.toContain('more lines')
})

test('inputs are left unchanged', () => {
  const args = Object.freeze({ ...replace })
  const result = Object.freeze({ success: true })
  expect(single('patch', args, result).path).toBe(args.path)
  expect(args).toEqual(replace)
  expect(result).toEqual({ success: true })
})

test('editorFramesFromTool always returns an array', () => {
  expect(editorFramesFromTool('read_file', { path: 'a.ts' }, null)).toEqual([])
  const one = editorFramesFromTool('write_file', { path: 'a.ts', content: 'x\n' }, null)
  expect(one).toHaveLength(1)
  expect(one[0]).toMatchObject({ path: 'a.ts', language: 'typescript' })
})
