import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SubagentFields } from './BoldStartJobSubagentFields.tsx'
import type { StartJobView } from './use-start-job-view.ts'

/** SA.3 part 3: the subagent pills are a radio group with a roving tab stop and arrow keys. */
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderFields(over: Partial<Record<string, unknown>> = {}) {
  const view = {
    leadAgent: { id: 'lead', name: 'Lead' },
    subagentsCeiling: { control: 'limits', maxConcurrent: 4 },
    subagentsLoading: false,
    subagentsError: false,
    subagentsOn: true,
    subagentsAtNow: 2,
    subagentsTotal: '20',
    subagentsTotalValid: true,
    subagentsProblem: null,
    setSubagentsOn: vi.fn(),
    setSubagentsAt: vi.fn(),
    setSubagentsTotal: vi.fn(),
    touch: vi.fn(),
    ...over,
  }
  render(<SubagentFields view={view as unknown as StartJobView} />)
  return view
}

const pill = (name: string) => screen.getByRole('radio', { name })

test('only the checked pill is in the tab order', () => {
  renderFields()
  const group = screen.getByRole('radiogroup', { name: 'Subagents' })
  const tabStops = within(group)
    .getAllByRole('radio')
    .map((item) => [item.textContent, item.tabIndex])
  expect(tabStops).toEqual([
    ['Off', -1],
    ['1', -1],
    ['2', 0],
    ['3', -1],
    ['4', -1],
  ])
})

test('the first enabled pill takes the tab stop when none is checked', () => {
  renderFields({ subagentsAtNow: null })
  expect(pill('Off').tabIndex).toBe(0)
  expect(pill('1').tabIndex).toBe(-1)
})

test('ArrowRight moves focus to the next pill and chooses it', () => {
  const view = renderFields()
  pill('2').focus()
  fireEvent.keyDown(pill('2'), { key: 'ArrowRight' })
  expect(view.setSubagentsAt).toHaveBeenCalledWith(3)
  expect(document.activeElement).toBe(pill('3'))
})

test('ArrowLeft and ArrowUp move back; the first pill wraps to the last', () => {
  const view = renderFields()
  fireEvent.keyDown(pill('Off'), { key: 'ArrowLeft' })
  expect(view.setSubagentsAt).toHaveBeenLastCalledWith(4)
  expect(document.activeElement).toBe(pill('4'))
  fireEvent.keyDown(pill('4'), { key: 'ArrowUp' })
  expect(view.setSubagentsAt).toHaveBeenLastCalledWith(3)
})

test('arrows skip disabled pills and wrap past them', () => {
  const view = renderFields({ subagentsCeiling: { control: 'limits', maxConcurrent: 2 } })
  expect(pill('3').hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(pill('Off'), { key: 'ArrowUp' })
  expect(view.setSubagentsAt).toHaveBeenLastCalledWith(2)
  expect(document.activeElement).toBe(pill('2'))
})

test('Off is chosen with an arrow too', () => {
  const view = renderFields()
  fireEvent.keyDown(pill('2'), { key: 'ArrowLeft' })
  fireEvent.keyDown(pill('1'), { key: 'ArrowLeft' })
  expect(view.setSubagentsOn).toHaveBeenLastCalledWith(false)
  expect(document.activeElement).toBe(pill('Off'))
})
