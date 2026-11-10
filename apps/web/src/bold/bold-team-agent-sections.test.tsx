import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { open } from './bold-team-helpers.tsx'

const agentPageCss = readFileSync(join(import.meta.dirname, 'agent-page', 'agent-page.css'), 'utf8')

const settings = {
  effort: 'high',
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [
    { name: 'fast', model: 'demo-fast', provider: 'demo', editable: true },
    { name: 'deep', model: 'demo-deep', provider: 'demo', editable: true },
  ],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: 'edge', model: null, voice: 'en-US-AriaNeural' },
  },
}
const subagents = {
  agentId: 'builder',
  control: 'limits',
  enabled: true,
  maxConcurrent: 4,
  model: null,
  maxIterations: 50,
  timeoutSeconds: null,
}
const efforts = {
  agentId: 'builder',
  own: 'high',
  levels: ['low', 'high', 'max'],
  chats: [
    { roomId: 'r1', roomName: 'Ship it', roomKind: 'group', jobTitle: null, effort: 'max' },
    { roomId: 'r2', roomName: 'Fix it', roomKind: 'group', jobTitle: null, effort: 'low' },
  ],
}

/** The page's own fetch stub, plus the three Model-section reads the shared helper leaves empty. */
function withModelReads() {
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const path = new URL(String(input), 'http://x').pathname
    if (path === '/api/agents/builder/model-settings')
      return Promise.resolve(Response.json(settings))
    if (path === '/api/agents/builder/subagents') return Promise.resolve(Response.json(subagents))
    if (path === '/api/agents/builder/efforts') return Promise.resolve(Response.json(efforts))
    return base(input, init)
  })
}

test('the section menu lists the sections, ends with Remove, and jumps to each one', async () => {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  open('/b/agents/builder')
  const menu = await screen.findByRole('navigation', { name: 'Sections' })
  const links = within(menu)
    .getAllByRole('link')
    .map((link) => link.textContent)
  expect(links).toEqual(['Personality', 'Model', 'Safety', 'Tools', 'Memory and skills', 'Work'])
  expect(within(menu).getByRole('button', { name: 'Remove builder' })).toBeDefined()
  expect(within(menu).getByRole('link', { name: 'Personality' }).getAttribute('aria-current')).toBe(
    'true',
  )
  scroll.mockClear()
  fireEvent.click(within(menu).getByRole('link', { name: 'Safety' }))
  expect(within(menu).getByRole('link', { name: 'Safety' }).getAttribute('aria-current')).toBe(
    'true',
  )
  expect(within(menu).getByRole('link', { name: 'Personality' }).getAttribute('aria-current')).toBe(
    null,
  )
  expect(scroll).toHaveBeenCalledTimes(1)
  expect((scroll.mock.contexts[0] as HTMLElement).id).toBe('agent-safety')
  // Every section the menu names is on the page, in one column.
  for (const id of ['personality', 'model', 'safety', 'section-tools', 'memory-skills', 'work'])
    expect(document.getElementById(`agent-${id}`)).not.toBeNull()
})

test('the menu’s Remove builder opens the same Remove panel and gives focus back to it', async () => {
  open('/b/agents/builder')
  const menu = await screen.findByRole('navigation', { name: 'Sections' })
  const remove = within(menu).getByRole('button', { name: 'Remove builder' })
  expect(remove.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(remove)
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  expect(remove.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(document.activeElement).toBe(remove))
})

test('the ⋯ menu also offers Remove, and Escape closes it', async () => {
  open('/b/agents/builder')
  const more = await screen.findByRole('button', { name: 'More actions' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(more)
  // Focus moves into the menu, and the arrow keys walk its items.
  const items = screen.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(items[0]!, { key: 'End' })
  expect(document.activeElement).toBe(items.at(-1))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove builder' }))
  expect(await screen.findByRole('group', { name: 'Remove builder' })).toBeDefined()
  expect(screen.queryByRole('menu')).toBeNull()
})

test('the Model section has a summary row for each setting, and each button opens that row’s form in place', async () => {
  withModelReads()
  open('/b/agents/builder')
  const model = await screen.findByRole('region', { name: 'Model' })
  expect(await within(model).findByText('fast, deep', { exact: false })).toBeDefined()
  expect(within(model).getByText(/Falls back to demo\/safe/)).toBeDefined()
  expect(within(model).getByText(/Speech to text: Automatic/)).toBeDefined()
  expect(within(model).getByText(/Edge \(free\), en-US-AriaNeural/)).toBeDefined()
  expect(
    await within(model).findByText(/up to 4 at once · 50 steps each · same model/),
  ).toBeDefined()
  expect(
    within(model).getByText(/Every chat uses this unless it sets its own with \/effort/),
  ).toBeDefined()
  // Nothing is open until a button asks.
  expect(within(model).queryByRole('form', { name: 'Change model' })).toBeNull()

  fireEvent.click(within(model).getByRole('button', { name: 'Change the model' }))
  expect(within(model).getByRole('form', { name: 'Change model' })).toBeDefined()

  // Rows open independently (review, 3.34.0): opening the aliases keeps the model form, and its draft, open.
  fireEvent.click(within(model).getByRole('button', { name: 'Edit model aliases' }))
  expect(within(model).getByRole('form', { name: 'Change model' })).toBeDefined()
  expect(within(model).getByRole('heading', { name: 'Aliases' })).toBeDefined()

  fireEvent.click(within(model).getByRole('button', { name: 'Change default effort' }))
  expect(within(model).getByRole('button', { name: 'Save effort' })).toBeDefined()
  expect(within(model).getByRole('heading', { name: 'Aliases' })).toBeDefined()
  // Each row's own button closes only that row.
  fireEvent.click(within(model).getByRole('button', { name: 'Close model aliases' }))
  expect(within(model).queryByRole('heading', { name: 'Aliases' })).toBeNull()
  expect(within(model).getByRole('form', { name: 'Change model' })).toBeDefined()

  fireEvent.click(within(model).getByRole('button', { name: 'Add fallback' }))
  expect(within(model).getByRole('heading', { name: 'Fallback models' })).toBeDefined()

  fireEvent.click(within(model).getByRole('button', { name: 'Edit voice' }))
  const voice = document.getElementById('agent-model-voice-form')!
  expect(within(voice).getByRole('button', { name: /Save/ })).toBeDefined()

  fireEvent.click(within(model).getByRole('button', { name: 'Edit subagents' }))
  expect(await within(model).findByRole('heading', { name: 'Subagents', level: 3 })).toBeDefined()
  fireEvent.click(within(model).getByRole('button', { name: 'Close subagents' }))
  expect(within(model).queryByRole('heading', { name: 'Subagents', level: 3 })).toBeNull()
})

test('"Set differently in 2 chats" opens the list of those chats', async () => {
  withModelReads()
  open('/b/agents/builder')
  const link = await screen.findByRole('button', { name: 'Set differently in 2 chats' })
  expect(screen.queryByRole('link', { name: 'Ship it' })).toBeNull()
  fireEvent.click(link)
  expect(await screen.findByRole('link', { name: 'Ship it' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Fix it' })).toBeDefined()
  expect(screen.getByText(/Every other chat uses high/)).toBeDefined()
})

test('the Model row for fallbacks names the chain by model, as the form does', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) =>
    new URL(String(input), 'http://x').pathname === '/api/agents/builder/model-settings'
      ? Promise.resolve(
          Response.json({
            ...settings,
            fallbacks: [
              { provider: 'upstage', model: 'solar-mini4:free' },
              { provider: 'demo', model: 'safe' },
            ],
          }),
        )
      : base(input, init),
  )
  open('/b/agents/builder')
  const model = await screen.findByRole('region', { name: 'Model' })
  expect(await within(model).findByText('Falls back to solar-mini4:free, then safe')).toBeDefined()
  expect(within(model).getByRole('button', { name: 'Edit fallback models' })).toBeDefined()
})

test('a link to #agent-workspace without a file opens the Files panel at the root', async () => {
  open('/b/agents/builder#agent-workspace')
  expect(await screen.findByRole('heading', { name: 'Files' })).toBeDefined()
  expect(document.getElementById('agent-files')).not.toBeNull()
})

test('a row whose Hermes settings could not be read says so instead of opening an empty form', async () => {
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) =>
    new URL(String(input), 'http://x').pathname === '/api/agents/builder/model-settings'
      ? Promise.resolve(
          Response.json({ error: { code: 'unavailable', message: 'no' } }, { status: 503 }),
        )
      : base(input, init),
  )
  open('/b/agents/builder')
  const model = await screen.findByRole('region', { name: 'Model' })
  fireEvent.click(within(model).getByRole('button', { name: 'Change default effort' }))
  const form = document.getElementById('agent-model-effort-form')!
  expect(await within(form).findByRole('alert')).toBeDefined()
  expect(within(form).getByText(/Couldn’t read this from Hermes/)).toBeDefined()
})

test('Edit moves focus into the panel, and Close gives it back to Edit', async () => {
  open('/b/agents/builder')
  const edit = await screen.findByRole('button', { name: 'Change name, role and look' })
  fireEvent.click(edit)
  const panel = await screen.findByRole('region', { name: 'Edit name, role and look' })
  await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true))
  fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.activeElement).toBe(edit))
})

test('Edit stays available (Looks always was), while Name and role needs a ready agent', async () => {
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Change name, role and look' }))
  expect(await screen.findByRole('heading', { name: 'Looks', level: 3 })).toBeDefined()
})

test('Memory and Skills are summaries; Open memory and Manage skills open today’s full cards', async () => {
  open('/b/agents/builder')
  const section = await screen.findByRole('region', { name: 'Memory and skills' })
  expect(await within(section).findByText('Nothing remembered yet.')).toBeDefined()
  expect(within(section).queryByRole('searchbox')).toBeNull()
  fireEvent.click(within(section).getByRole('button', { name: 'Open memory' }))
  expect(
    await within(section).findByRole('heading', { name: /^Remembers/, level: 3 }),
  ).toBeDefined()
  expect(document.getElementById('agent-memory')).not.toBeNull()
  fireEvent.click(within(section).getByRole('button', { name: 'Manage skills' }))
  expect(
    await within(section).findByRole('search', { name: 'Search the skills hub' }),
  ).toBeDefined()
})

test('a link to #agent-memory opens the memory card in place', async () => {
  open('/b/agents/builder#agent-memory')
  expect(await screen.findByRole('heading', { name: /^Remembers/, level: 3 })).toBeDefined()
  expect(document.getElementById('agent-memory')).not.toBeNull()
})

test('Plugins is a summary with Manage plugins', async () => {
  open('/b/agents/builder')
  const tools = await screen.findByRole('region', { name: 'Tools' })
  expect(within(tools).getByRole('heading', { name: /^Plugins/, level: 3 })).toBeDefined()
  fireEvent.click(await within(tools).findByRole('button', { name: 'Manage plugins' }))
  expect(await within(tools).findByText('No plugins installed.')).toBeDefined()
})

test('a coding agent gets the same menu without memory and skills, and one Remove', async () => {
  open('/b/agents/coder')
  const menu = await screen.findByRole('navigation', { name: 'Sections' })
  expect(
    within(menu)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['Personality', 'Model', 'Safety', 'Tools', 'Work'])
  expect(within(menu).getByRole('button', { name: 'Remove coder' })).toBeDefined()
  // The old Danger zone card is gone: one remove flow.
  expect(screen.queryByRole('heading', { name: 'Danger zone' })).toBeNull()
  expect(await screen.findByRole('heading', { name: 'Limits left' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Access' })).toBeDefined()
  for (const id of ['personality', 'model', 'safety', 'section-tools', 'work'])
    expect(document.getElementById(`agent-${id}`)).not.toBeNull()
  expect(document.getElementById('agent-memory-skills')).toBeNull()
})

test('on a phone the section menu is a row of 44px chips that scrolls sideways inside itself', () => {
  const phone = agentPageCss.slice(agentPageCss.indexOf('@media (max-width: 860px)'))
  const menu = phone.slice(
    phone.indexOf('.bold-agent-menu {'),
    phone.indexOf('}', phone.indexOf('.bold-agent-menu {')),
  )
  expect(menu).toContain('flex-direction: row')
  expect(menu).toContain('overflow-x: auto')
  expect(menu).toContain('position: static')
  expect(phone).toMatch(/\.bold-agent-menu a,[\s\S]*?min-height: 44px/)
  expect(phone).toMatch(/\.bold-agent-body \{[^}]*flex-direction: column/)
  // On a desktop it stays in the page's flow: sticky, never a viewport-high column.
  const desktop = agentPageCss.slice(0, agentPageCss.indexOf('@media'))
  expect(desktop).toMatch(/\.bold-agent-menu \{[^}]*position: sticky/)
  expect(desktop).not.toMatch(/100vh/)
})
