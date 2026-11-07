import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { disposers, open, shellState } from './BoldShell-helpers.tsx'
import { fullTopic, plainTopic, runTopic } from './BoldShell-run-fixtures.ts'

// 3.25.0: Results folded into Info (DECISIONS 161): the Files and results section and the viewer sheet.
const madeAt = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
const filesResults = (count: number) => ({
  asOfSeq: 2,
  items: [
    {
      kind: 'change',
      id: 'change:job-plain',
      title: 'Plain',
      authors: ['builder'],
      state: 'working',
      whatChanged: [],
      files: Array.from({ length: count }, (_, index) => ({
        path: `api/file-${index + 1}.py`,
        added: 1,
        removed: 0,
        by: ['builder'],
      })),
      at: madeAt(10),
    },
    {
      kind: 'draft',
      id: 'draft-notes',
      agentId: 'designer',
      title: 'Release notes',
      target: { kind: 'workspace', path: 'docs/notes.md' },
      at: madeAt(20),
    },
  ],
  screens: [
    {
      agentId: 'builder',
      seq: 3,
      surface: 'terminal',
      caption: 'Ran the tests',
      live: false,
      at: madeAt(30),
    },
  ],
})
const filesWorkbench = {
  asOfSeq: 2,
  files: [
    {
      path: 'api/file-1.py',
      language: 'python',
      exact: false,
      lines: [{ n: 1, text: 'PAGE_SIZE = 50', by: 'builder' }],
      cursors: [],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: madeAt(10),
    },
  ],
  looseComments: [],
  drafts: [
    {
      kind: 'draft',
      id: 'draft-notes',
      agentId: 'designer',
      title: 'Release notes',
      target: { kind: 'workspace', path: 'docs/notes.md' },
      at: madeAt(20),
    },
  ],
  screens: [],
}
const openWithFiles = (path: string, count = 2) => {
  shellState.resultsFixture = filesResults(count)
  shellState.workbenchFixture = filesWorkbench
  shellState.runJobs = [{ ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null }]
  return open(path, [plainTopic])
}

test('Info lists what the current topic made: icon, name, who made it, newest first', async () => {
  openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  const rows = await within(section).findAllByRole('link')
  expect(rows.map((row) => row.getAttribute('data-files-row'))).toEqual([
    'screen:builder',
    'draft:draft-notes',
    'code:api/file-1.py',
    'code:api/file-2.py',
  ])
  expect(rows[0]!.textContent).toContain('builder’s screen')
  expect(rows[1]!.textContent).toContain('Release notes')
  expect(rows[1]!.textContent).toContain('designer')
  expect(rows[2]!.textContent).toContain('file-1.py')
  expect(rows[2]!.textContent).toContain('builder')
  expect(within(section).queryByRole('button', { name: /Show all/ })).toBeNull()
})

test('Info says so quietly when nothing was made in the job', async () => {
  shellState.runJobs = [{ ...fullTopic(plainTopic as unknown as typeof runTopic), recipe: null }]
  open('/b?job=job-plain', [plainTopic])
  const section = await screen.findByTestId('files-results')
  expect(await within(section).findByText('Nothing made in this job yet')).toBeDefined()
  expect(within(section).queryByRole('link')).toBeNull()
})

test('more than six rows fold behind Show all (N)', async () => {
  openWithFiles('/b?job=job-plain', 8)
  const section = await screen.findByTestId('files-results')
  await within(section).findAllByRole('link')
  expect(within(section).getAllByRole('link')).toHaveLength(6)
  fireEvent.click(within(section).getByRole('button', { name: 'Show all (10)' }))
  expect(within(section).getAllByRole('link')).toHaveLength(10)
  fireEvent.click(within(section).getByRole('button', { name: 'Show fewer' }))
  expect(within(section).getAllByRole('link')).toHaveLength(6)
})

test('the conversation under the viewer sheet is inert, and a waiting card is cued on the sheet', async () => {
  const router = openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  fireEvent.click(await within(section).findByRole('link', { name: /Release notes/ }))
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const column = sheet.closest('.roomcol')!
  const under = [...column.children].filter((child) => child !== sheet)
  expect(under.length).toBeGreaterThan(0)
  for (const child of under) expect(child.hasAttribute('inert')).toBe(true)
  expect(sheet.hasAttribute('inert')).toBe(false)
  // The title is not a .bold-chat-kicker, which a phone hides visually.
  const title = within(sheet).getByRole('heading', { name: 'Files and results' })
  expect(title.className).toBe('bold-viewer-title')
  // No card waits: no cue.
  expect(within(sheet).queryByText(/need.* you/)).toBeNull()

  // A needs-you card appears in the conversation under the sheet.
  const stream = document.getElementById('bold-room-stream')!
  const card = document.createElement('div')
  card.setAttribute('data-pin-key', 'approval:a1')
  card.tabIndex = -1
  card.getBoundingClientRect = () => ({ top: 10, bottom: 60, height: 50 }) as DOMRect
  stream.appendChild(card)
  const cue = await within(sheet).findByRole('button', { name: '1 needs you · Back to the chat' })
  expect(cue.getAttribute('data-protected')).not.toBeNull()
  fireEvent.click(cue)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  expect(router.state.location.search).not.toContain('work=')
  for (const child of under) expect(child.hasAttribute('inert')).toBe(false)
  await waitFor(() => expect(document.activeElement).toBe(card))
})

test('on a phone the cue also closes the Info sheet, so the card it goes to is not covered', async () => {
  shellState.phone = true
  openWithFiles('/b?job=job-plain')
  fireEvent.click(await screen.findByRole('button', { name: 'Chat info' }))
  const panel = await screen.findByRole('complementary', { name: 'Side panel' })
  fireEvent.click(await within(panel).findByRole('link', { name: /Release notes/ }))
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const stream = document.getElementById('bold-room-stream')!
  const card = document.createElement('div')
  card.setAttribute('data-pin-key', 'approval:a1')
  card.tabIndex = -1
  card.getBoundingClientRect = () => ({ top: 10, bottom: 60, height: 50 }) as DOMRect
  stream.appendChild(card)
  fireEvent.click(
    await within(sheet).findByRole('button', { name: '1 needs you · Back to the chat' }),
  )
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull(),
  )
  await waitFor(() => expect(document.activeElement).toBe(card))
})

test('a row opens the viewer sheet over the conversation; Escape and the close button return focus to the row', async () => {
  const router = openWithFiles('/b?job=job-plain')
  const section = await screen.findByTestId('files-results')
  const row = await within(section).findByRole('link', { name: /Release notes/ })
  row.focus()
  fireEvent.click(row)
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(router.state.location.search).toContain('work=draft')
  expect(router.state.location.search).toContain('job=job-plain')
  // The sheet sits in the conversation column; the side panel stays.
  expect(sheet.closest('.roomcol')).not.toBeNull()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(await within(sheet).findByText('Release notes', { selector: 'h2' })).toBeDefined()
  expect(document.activeElement).toBe(
    within(sheet).getByRole('button', { name: 'Close the viewer' }),
  )

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  expect(router.state.location.search).not.toContain('work=')
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-files-row')).toBe('draft:draft-notes'),
  )

  fireEvent.click(screen.getByRole('link', { name: /Release notes/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close the viewer' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull())
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-files-row')).toBe('draft:draft-notes'),
  )
})

test('on a phone the viewer is a full-screen sheet of its own', async () => {
  shellState.phone = true
  openWithFiles('/b?job=job-plain&work=draft')
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(sheet.className).toContain('phone')
  expect(sheet.closest('.roomcol')).toBeNull()
})

test('?work=draft and ?work=code&file= open the viewer on that item', async () => {
  openWithFiles('/b?job=job-plain&work=code&file=api%2Ffile-1.py')
  const sheet = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  const fileTab = await within(sheet).findByRole('button', { name: 'api/file-1.py' })
  expect(fileTab.getAttribute('aria-pressed')).toBe('true')
  expect(sheet.textContent).toContain('PAGE_SIZE')
  // Nothing opened a dead tab: Info is the tab, there is no Results tab.
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  openWithFiles('/b?job=job-plain&work=draft')
  const draft = await screen.findByRole('dialog', { name: 'Workbench viewer' })
  expect(await within(draft).findByText('Release notes', { selector: 'h2' })).toBeDefined()
})

test('?work=results opens Info at Files and results, with no viewer sheet', async () => {
  openWithFiles('/b?job=job-plain&work=results')
  await screen.findByTestId('files-results')
  expect(screen.queryByRole('dialog', { name: 'Workbench viewer' })).toBeNull()
  const tabs = screen.getByRole('tablist', { name: 'Panel' })
  expect(within(tabs).getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('heading', { name: 'Files and results' })).toBeDefined()
})

test('a one-to-one has the same Files and results in its Info', async () => {
  shellState.resultsFixture = filesResults(1)
  shellState.workbenchFixture = filesWorkbench
  open('/b?with=builder&chat=chat-1')
  const section = await screen.findByTestId('files-results')
  expect(within(section).getByRole('heading', { name: 'Files and results' })).toBeDefined()
})
