import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { mcp } from './agent-more/agent-more-helpers.tsx'
import { open } from './bold-team-helpers.tsx'

const agentPageCss = readFileSync(join(import.meta.dirname, 'agent-page', 'agent-page.css'), 'utf8')

const channel = (label: string, platform: string, status: 'connected' | 'disconnected') => ({
  platform,
  label,
  status,
  detail: null,
  connectCommand: `hermes setup ${platform}`,
})

const run = (title: string, runId: string) => ({
  runId,
  title,
  origin: 'score',
  outcome: 'completed',
  startedAt: '2026-10-24T10:00:00.000Z',
  durationSec: 60,
  model: null,
  costUsd: null,
  task: null,
  brief: null,
  replaySeq: null,
})

/** The page's fetch stub, with the Tools and Work reads these tests need set to their own answers. */
function withTileReads(reads: { channels?: unknown[]; mcp?: object; history?: unknown[] }) {
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const path = new URL(String(input), 'http://x').pathname
    if (path === '/api/agents/builder/channels' && reads.channels)
      return Promise.resolve(Response.json({ items: reads.channels }))
    if (path === '/api/agents/builder/mcp' && reads.mcp)
      return Promise.resolve(Response.json(reads.mcp))
    if (path === '/api/agents/builder/history' && reads.history)
      return Promise.resolve(Response.json({ items: reads.history, nextCursor: null }))
    return base(input, init)
  })
}

test('Tools: Can use on the left; Reachable on and Score access are one line each and open in place', async () => {
  withTileReads({
    channels: [
      channel('Telegram', 'telegram', 'connected'),
      channel('Discord', 'discord', 'disconnected'),
      channel('Slack', 'slack', 'disconnected'),
    ],
    mcp: { ...mcp, enabled: false },
  })
  open('/b/agents/builder')
  const tools = await screen.findByRole('region', { name: 'Tools' })
  expect(within(tools).getByRole('heading', { name: 'Can use', level: 3 })).toBeDefined()
  expect(await within(tools).findByText('Telegram · Discord and Slack not connected')).toBeDefined()
  expect(await within(tools).findByText('Off')).toBeDefined()
  // Each line's action opens today's full card where the line is.
  fireEvent.click(within(tools).getByRole('button', { name: 'Manage channels' }))
  expect(await screen.findByRole('heading', { name: 'Channels', level: 3 })).toBeDefined()
  expect(document.getElementById('agent-channels')).not.toBeNull()
  fireEvent.click(within(tools).getByRole('button', { name: 'Turn on Score access' }))
  expect(await screen.findByRole('checkbox', { name: /Read rooms, tasks and notes/ })).toBeDefined()
  expect(document.getElementById('agent-score-access')?.getAttribute('data-protected')).toBe('flex')
})

test('Safety: each tile states its state in one line; Never rules adds inline; Asks opens its checkboxes in place', async () => {
  open('/b/agents/builder')
  const asks = await screen.findByRole('region', { name: 'Asks you first before' })
  expect(within(asks).getByText('Installing packages')).toBeDefined()
  expect(within(asks).queryByRole('checkbox')).toBeNull()
  const never = screen.getByRole('region', { name: /^Never rules/ })
  expect(within(never).getByRole('form', { name: 'Add a Never rule' })).toBeDefined()
  expect(within(never).getByRole('button', { name: 'Add' })).toBeDefined()
  fireEvent.click(within(asks).getByRole('button', { name: 'Change what it asks you first about' }))
  const card = await screen.findByRole('region', { name: 'Asks you first before' })
  expect(await within(card).findByRole('checkbox', { name: 'Installing packages' })).toBeDefined()
})

test('Work: Recent runs lists the last two runs in one line each, and All runs opens the full card in place', async () => {
  withTileReads({ history: [run('Run one', 'r1'), run('Run two', 'r2'), run('Run three', 'r3')] })
  open('/b/agents/builder')
  const work = await screen.findByRole('region', { name: 'Recent runs' })
  expect(await within(work).findByText(/^Run one · /)).toBeDefined()
  expect(within(work).getByText(/^Run two · /)).toBeDefined()
  expect(within(work).queryByText(/Run three/)).toBeNull()
  fireEvent.click(within(work).getByRole('button', { name: 'All runs' }))
  expect(await screen.findByText('Run three')).toBeDefined()
  expect(document.getElementById('agent-history')).not.toBeNull()
})

test('Personality is one section: its heading and both file toggles on one row, with no card inside', async () => {
  open('/b/agents/builder')
  const heading = await screen.findByRole('heading', { name: 'Personality', level: 2 })
  const row = heading.parentElement!
  expect(row.classList.contains('bold-agent-files-head')).toBe(true)
  const toggles = within(row).getByRole('group', { name: 'File to edit' })
  const soul = within(toggles).getByRole('button', { name: 'Who it is · SOUL.md' })
  expect(soul.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(within(toggles).getByRole('button', { name: 'Operating rules · AGENTS.md' }))
  expect(
    within(toggles)
      .getByRole('button', { name: 'Operating rules · AGENTS.md' })
      .getAttribute('aria-pressed'),
  ).toBe('true')
  expect(document.querySelector('#agent-personality .card')).toBeNull()
  expect(document.querySelector('#agent-personality .team-card')).toBeNull()
})

test('a link to a summary’s card (#agent-channels) opens that card in place', async () => {
  open('/b/agents/builder#agent-channels')
  expect(await screen.findByRole('heading', { name: 'Channels', level: 3 })).toBeDefined()
  expect(document.getElementById('agent-channels')).not.toBeNull()
})

test('on a phone the Personality toggles scroll sideways inside their row and never wrap a label', () => {
  const toggles = agentPageCss.slice(
    agentPageCss.indexOf('.bold-agent-files-toggles {'),
    agentPageCss.indexOf('}', agentPageCss.indexOf('.bold-agent-files-toggles {')),
  )
  expect(toggles).toContain('overflow-x: auto')
  expect(toggles).toContain('flex-wrap: nowrap')
  expect(agentPageCss).toMatch(/\.bold-agent-files-toggles button \{[^}]*white-space: nowrap/)
  // The phone keeps the toggles on the heading's row: the row is a flex row, not a stack.
  expect(agentPageCss).toMatch(/\.bold-agent-files-head \{[^}]*display: flex/)
})
