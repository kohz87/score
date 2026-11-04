import type { JobResults } from '@score/contract'
import { expect, test } from 'vitest'
import { fileRows, isViewerWork, viewerClosedSearch, viewerLink } from './files-model.ts'

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
const name = (id: string) => `${id}’s screen`

const results: JobResults = {
  asOfSeq: 5,
  items: [
    {
      kind: 'change',
      id: 'change:a',
      title: 'A',
      authors: ['builder'],
      state: 'working',
      whatChanged: [],
      files: [{ path: 'api/events.py', added: 1, removed: 0, by: ['builder'] }],
      at: at(1),
    },
    {
      kind: 'change',
      id: 'change:b',
      title: 'B',
      authors: ['reviewer'],
      state: 'working',
      whatChanged: [],
      files: [{ path: 'api/events.py', added: 0, removed: 1, by: ['reviewer'] }],
      at: at(5),
    },
    {
      kind: 'preview',
      id: 'preview:1',
      agentId: 'builder',
      url: 'http://localhost:5173/feed',
      title: null,
      imageUrl: null,
      live: true,
      at: at(3),
    },
  ],
  screens: [
    {
      agentId: 'builder',
      seq: 2,
      surface: 'terminal',
      caption: 'Ran tests',
      live: false,
      at: at(4),
    },
  ],
}

test('rows are files, drafts, screens and links, newest first, one row per file', () => {
  const rows = fileRows(results, name)
  expect(rows.map((row) => [row.kind, row.name, row.tab])).toEqual([
    ['file', 'events.py', 'code'],
    ['screen', 'builder’s screen', 'screen'],
    ['link', 'localhost:5173', 'screen'],
  ])
  expect(rows[0]).toMatchObject({ file: 'api/events.py', by: ['builder', 'reviewer'], at: at(5) })
})

test('no results is no rows', () => {
  expect(fileRows(undefined, name)).toEqual([])
})

test('the viewer address keeps the rest of the address and the close drops only the viewer', () => {
  expect(viewerLink('?room=r1&job=old&file=x', 'job-1', 'draft')).toBe(
    '/b?room=r1&job=job-1&work=draft',
  )
  expect(viewerLink('?with=builder', 'chat-1', 'code', 'api/a.py')).toBe(
    '/b?with=builder&job=chat-1&work=code&file=api%2Fa.py',
  )
  expect(
    viewerClosedSearch(new URLSearchParams('room=r1&job=job-1&work=code&file=a')).toString(),
  ).toBe('room=r1&job=job-1')
})

test('only the Workbench addresses open the viewer', () => {
  for (const work of ['workbench', 'code', 'screen', 'draft']) expect(isViewerWork(work)).toBe(true)
  for (const work of ['graph', 'results', null, 'other']) expect(isViewerWork(work)).toBe(false)
})
