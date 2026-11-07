import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { RunsCard } from './RunsCard.tsx'
import {
  agent,
  at,
  initialMemory,
  setUpAgentMoreTests,
  type Call,
  type Memory,
  type Override,
} from './agent-more-helpers.tsx'

let calls: Call[] = []
let override: Override | null = null
let memory: Memory[] = initialMemory()
const { mount } = setUpAgentMoreTests({
  calls: () => calls,
  override: () => override,
  memory: () => memory,
  setMemory: (next) => {
    memory = next
  },
  reset: () => {
    calls = []
    override = null
    memory = initialMemory()
  },
})

test('Recent runs link to the replay', async () => {
  mount(<RunsCard agent={agent} />)
  expect(await screen.findByText('Fix the feed')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Replay Fix the feed' }).getAttribute('href')).toBe(
    '/watch/builder?from=7',
  )
})

test('Recent runs: filter by outcome and show each run cost', async () => {
  override = (path) => {
    if (!path.includes('/history')) return null
    const failed = path.includes('outcome=failed')
    const items = [
      {
        runId: 'run-1',
        title: 'Fix the feed',
        origin: 'score',
        outcome: 'completed',
        startedAt: at,
        durationSec: 60,
        model: null,
        costUsd: 1.5,
        task: null,
        brief: null,
        replaySeq: 7,
      },
      {
        runId: 'run-2',
        title: 'Break the build',
        origin: 'score',
        outcome: 'failed',
        startedAt: at,
        durationSec: 5,
        model: null,
        costUsd: null,
        task: null,
        brief: null,
        replaySeq: null,
      },
    ]
    return Response.json({
      items: failed ? items.filter((run) => run.outcome === 'failed') : items,
      nextCursor: null,
    })
  }
  mount(<RunsCard agent={agent} />)
  expect(await screen.findByText('Fix the feed')).toBeDefined()
  expect(screen.getByText(/\$1\.50/)).toBeDefined()
  expect(screen.getByText(/cost unknown/)).toBeDefined()
  const group = screen.getByRole('group', { name: 'Filter runs by outcome' })
  fireEvent.click(within(group).getByRole('button', { name: 'Failed' }))
  await waitFor(() => expect(screen.queryByText('Fix the feed')).toBeNull())
  expect(await screen.findByText('Break the build')).toBeDefined()
  expect(within(group).getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  fireEvent.click(within(group).getByRole('button', { name: 'All' }))
  expect(await screen.findByText('Fix the feed')).toBeDefined()
})
