import { expect, test } from 'vitest'
import {
  INLINE_FILE_BYTES,
  INLINE_MESSAGE_BYTES,
  attachmentNote,
  safeFileName,
  type AttachedDocument,
  type AttachmentWorkspace,
} from '../src/domain/attachment-input.ts'
import { WorkspaceError } from '../src/workspace/policy.ts'

const doc = (name: string, contentType: string, bytes: Buffer): AttachedDocument => ({
  mediaId: `id-${name}`,
  name,
  contentType,
  size: bytes.length,
  load: () => bytes,
})
function memoryWorkspace() {
  const files = new Map<string, Buffer>()
  const workspace: AttachmentWorkspace = {
    async create(path) {
      if (path.includes('exists')) throw new WorkspaceError(409, 'exists', 'exists')
    },
    async upload(path, bytes) {
      if (files.has(path)) throw new WorkspaceError(409, 'exists', 'exists')
      files.set(path, bytes)
    },
    async read(path) {
      const bytes = files.get(path)
      return bytes ? { kind: 'download', bytes } : { kind: 'missing' }
    },
  }
  return { files, workspace }
}
const run = (documents: AttachedDocument[], workspace: () => Promise<AttachmentWorkspace>) =>
  attachmentNote({ agentId: 'builder', documents, references: [], day: '2026-10-09', workspace })

test('file names lose directories, control characters and leading dots', () => {
  expect(safeFileName('../../etc/passwd')).toBe('passwd')
  expect(safeFileName('C:\\temp\\a.pdf')).toBe('a.pdf')
  expect(safeFileName('..hidden\u0000.pdf')).toBe('hidden.pdf')
  expect(safeFileName('a<b>|c?.pdf')).toBe('a_b__c_.pdf')
  expect(safeFileName('   ')).toBe('file')
  expect(safeFileName('x'.repeat(300)).length).toBe(100)
  expect(safeFileName('Übersicht Q3.xlsx')).toBe('Übersicht Q3.xlsx')
})

test('text is fenced, longer fences protect content that has fences, and secrets are redacted', async () => {
  const { note } = await run(
    [doc('a.md', 'text/markdown', Buffer.from('```js\nlet token = "sk-abcdefghijklmnop"\n```'))],
    async () => memoryWorkspace().workspace,
  )
  expect(note).toContain('Attached file: a.md (text/markdown, 43 B)\n````markdown\n')
  expect(note).toContain('\n````')
  expect(note).not.toContain('sk-abcdefghijklmnop')
})

test('one file is cut at 64 KB and a message at 200 KB, with a note, on character boundaries', async () => {
  const big = Buffer.from('é'.repeat(INLINE_FILE_BYTES))
  const one = await run(
    [doc('big.txt', 'text/plain', big)],
    async () => memoryWorkspace().workspace,
  )
  expect(one.note).toContain('(truncated: only the first 64 KB are shown)')
  expect(one.note).not.toContain('\uFFFD')
  const files = Array.from({ length: 5 }, (_, i) =>
    doc(`f${i}.txt`, 'text/plain', Buffer.from('x'.repeat(INLINE_FILE_BYTES - 1))),
  )
  const many = await run(files, async () => memoryWorkspace().workspace)
  expect(Buffer.byteLength(many.note)).toBeLessThan(INLINE_MESSAGE_BYTES + 2048)
  expect(many.note).toContain('f3.txt')
  expect(many.note).toMatch(/f4\.txt[^]*not included/)
})

test('binary documents are saved under attachments/<day>/ and reuse identical bytes', async () => {
  const { files, workspace } = memoryWorkspace()
  const bytes = Buffer.from('%PDF-1.7 one')
  const first = await run([doc('r.pdf', 'application/pdf', bytes)], async () => workspace)
  expect(first.note).toBe('\n\nAttached: attachments/2026-10-09/r.pdf')
  expect(first.saved).toEqual([{ mediaId: 'id-r.pdf', path: 'attachments/2026-10-09/r.pdf' }])
  const same = await run([doc('r.pdf', 'application/pdf', bytes)], async () => workspace)
  expect(same.note).toContain('attachments/2026-10-09/r.pdf')
  const other = await run(
    [doc('r.pdf', 'application/pdf', Buffer.from('%PDF-1.7 two'))],
    async () => workspace,
  )
  expect(other.note).toContain('attachments/2026-10-09/r-2.pdf')
  expect([...files.keys()].sort()).toEqual([
    'attachments/2026-10-09/r-2.pdf',
    'attachments/2026-10-09/r.pdf',
  ])
})

test('an unavailable workspace, or a refused write, sends only the name and a notice', async () => {
  const down = await run([doc('r.pdf', 'application/pdf', Buffer.from('%PDF-'))], async () => {
    throw new Error('No working folder is set for this agent')
  })
  expect(down.note).toBe('\n\nAttached (could not be saved to your workspace): r.pdf')
  expect(down.notices).toEqual([
    'r.pdf was not saved for @builder: No working folder is set for this agent',
  ])
  const refused = await run([doc('r.pdf', 'application/pdf', Buffer.from('%PDF-'))], async () => ({
    ...memoryWorkspace().workspace,
    upload: async () => {
      throw new WorkspaceError(403, 'blocked', 'That path is not available')
    },
  }))
  expect(refused.notices[0]).toContain('That path is not available')
})
