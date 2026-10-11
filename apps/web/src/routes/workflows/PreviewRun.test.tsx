import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { releaseDefinition } from '../../../../../e2e/workflow-fixtures.ts'
import { stubReducedMotion } from '../../motion/test-support.ts'
import { WorkflowPreview } from './PreviewRun.tsx'

const agents = [
  { id: 'lead', name: 'lead', style: { color: '#6B4EFF', shape: 'circle-dot' } },
  { id: 'builder', name: 'builder', style: { color: '#19C39A', shape: 'square' } },
  { id: 'reviewer', name: 'reviewer', style: { color: '#FFB61E', shape: 'triangle' } },
] as never

beforeEach(() => {
  vi.useFakeTimers()
  // With reduced motion the diagram highlights instead of animating dots: nothing here depends on the Web Animations API.
  stubReducedMotion()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
// React runs an effect (the next timer) only when the act ends, so each step of the preview is its own tick.
const steps = async (count: number) => {
  for (let i = 0; i < count; i++) await tick(1400)
}
const node = (name: RegExp) => screen.getByRole('button', { name })

function mount(onStop = vi.fn()) {
  render(<WorkflowPreview draft={releaseDefinition} agents={agents} onStop={onStop} />)
  return onStop
}

test('says that nothing runs, and lights the steps one after another until a gate asks', async () => {
  mount()
  expect(screen.getByText('Preview: nothing runs, no tokens')).toBeTruthy()
  expect(node(/Step Draft the notes.*running/)).toBeTruthy()
  await steps(1)
  expect(node(/Step Draft the notes.*succeeded/)).toBeTruthy()
  expect(node(/Step Review the draft.*running/)).toBeTruthy()
  await steps(1)
  const ask = screen.getByLabelText('Preview: Approve the draft')
  expect(within(ask).getByText('Is the reviewed draft good enough to publish?')).toBeTruthy()
  expect(node(/Gate Approve the draft.*needs you/)).toBeTruthy()
  // Nothing moves while it waits.
  await tick(10_000)
  expect(screen.getByLabelText('Preview: Approve the draft')).toBeTruthy()
})

test('approving at the gate asks which branch outcome to follow, the first rule by default', async () => {
  mount()
  await steps(2)
  fireEvent.click(screen.getByRole('button', { name: 'Continue as approved' }))
  await steps(1)
  const ask = screen.getByLabelText('Preview: Passed review?')
  const options = within(ask).getAllByRole('radio') as HTMLInputElement[]
  expect(options.map((option) => option.checked)).toEqual([true, false])
  fireEvent.click(options[1]!)
  fireEvent.click(within(ask).getByRole('button', { name: 'Continue' }))
  await steps(3)
  // “Otherwise” leads to the repair step; the published end is passed over.
  expect(node(/Step Repair the draft.*succeeded/)).toBeTruthy()
  expect(screen.getByText('Preview finished. Nothing ran.')).toBeTruthy()
})

test('rejecting a gate that stops the run ends the preview', async () => {
  mount()
  await steps(2)
  fireEvent.click(screen.getByRole('button', { name: 'Continue as rejected' }))
  await tick(100)
  expect(screen.getByText(/the gate was rejected and rejecting stops the run/)).toBeTruthy()
})

test('4× goes faster, and Stop hands control back', async () => {
  const onStop = mount()
  fireEvent.click(screen.getByRole('button', { name: '4×' }))
  expect(screen.getByRole('button', { name: '4×' }).getAttribute('aria-pressed')).toBe('true')
  for (let i = 0; i < 2; i++) await tick(400)
  expect(screen.getByLabelText('Preview: Approve the draft')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(onStop).toHaveBeenCalledTimes(1)
})
