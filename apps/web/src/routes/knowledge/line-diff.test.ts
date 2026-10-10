import { expect, test } from 'vitest'
import { lineDiff } from './line-diff.ts'
import {
  buildTree,
  linkTargetFor,
  normalizeNewPath,
  notePath,
  pathForLinkTarget,
  timeAgo,
} from './knowledge-paths.ts'
import { resolveTarget, splitSnippet, wikilinksToMarkdown } from './wikilinks.ts'

test('lineDiff marks added and removed lines and keeps the unchanged ones', () => {
  expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
    { kind: 'same', text: 'a' },
    { kind: 'removed', text: 'b' },
    { kind: 'same', text: 'c' },
    { kind: 'added', text: 'd' },
  ])
  expect(lineDiff('same', 'same').every((line) => line.kind === 'same')).toBe(true)
  expect(lineDiff('', 'x')).toEqual([{ kind: 'added', text: 'x' }])
})

test('paths: normalise, encode, and link targets', () => {
  expect(normalizeNewPath('  /ideas/launch plan ')).toBe('ideas/launch plan.md')
  expect(normalizeNewPath('a.MD')).toBe('a.MD')
  expect(normalizeNewPath('dir/')).toBeNull()
  expect(normalizeNewPath('   ')).toBeNull()
  expect(notePath('a b/c#d.md')).toBe('a%20b/c%23d.md')
  expect(pathForLinkTarget('Plan#Goals')).toBe('Plan.md')
  const notes = [
    { path: 'a/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
    { path: 'b/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
    { path: 'Idea.md', title: 'Idea', mtime: '', lastAuthor: null },
  ]
  expect(linkTargetFor(notes[0]!, notes)).toBe('a/Plan')
  expect(linkTargetFor(notes[2]!, notes)).toBe('Idea')
})

test('buildTree nests folders (empty ones too), folders first, then notes by name', () => {
  const tree = buildTree({
    folders: ['empty', 'a'],
    documents: [],
    notes: [
      { path: 'z.md', title: 'z', mtime: '', lastAuthor: null },
      { path: 'a/b/n.md', title: 'n', mtime: '', lastAuthor: null },
    ],
  })
  expect(tree.map((node) => node.path)).toEqual(['a', 'empty', 'z.md'])
  const a = tree[0]!
  expect(a.kind === 'folder' && a.children[0]!.path).toBe('a/b')
})

test('wikilinks become preview links, except inside code fences', () => {
  const out = wikilinksToMarkdown('See [[Plan|the plan]] and [[Idea#Top]].\n```\n[[Code]]\n```')
  expect(out).toContain('[the plan](#wiki:Plan)')
  expect(out).toContain('[Idea#Top](#wiki:Idea%23Top)')
  expect(out).toContain('[[Code]]')
})

test('resolveTarget prefers the server, then exact path, then a unique name', () => {
  const notes = [
    { path: 'a/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
    { path: 'b/Idea.md', title: 'Idea', mtime: '', lastAuthor: null },
    { path: 'c/Idea.md', title: 'Idea', mtime: '', lastAuthor: null },
  ]
  expect(resolveTarget('Plan', [{ target: 'Plan', path: 'x/Plan.md' }], notes)).toBe('x/Plan.md')
  expect(resolveTarget('plan#h', [], notes)).toBe('a/Plan.md')
  expect(resolveTarget('Idea', [], notes)).toBeNull()
  expect(resolveTarget('b/Idea', [], notes)).toBe('b/Idea.md')
})

test('snippets and times', () => {
  expect(splitSnippet('a [[hit]] b')).toEqual([
    { text: 'a ', match: false },
    { text: 'hit', match: true },
    { text: ' b', match: false },
  ])
  const now = Date.parse('2026-01-01T00:10:00Z')
  expect(timeAgo('2026-01-01T00:08:00Z', now)).toBe('2 min ago')
  expect(timeAgo('2026-01-01T00:09:50Z', now)).toBe('just now')
})
