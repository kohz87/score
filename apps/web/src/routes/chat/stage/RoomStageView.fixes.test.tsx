import type { AgentSummary } from '@score/contract'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveLiveliness } from '../../../data/liveliness.ts'
import { RoomStageView, type StageMember } from './RoomStageView.tsx'
import type { StageMood } from './stage-mood.ts'

const css = readFileSync('src/routes/chat/stage/room-stage.css', 'utf8')
const agent = (id: string): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const member = (id: string, mood: StageMood = 'rest'): StageMember => ({
  agent: agent(id),
  mood,
})
const view = (members: StageMember[], extra: { quiet?: boolean } = {}) => (
  <RoomStageView roomId="r" members={members} handoff={null} onMention={() => {}} {...extra} />
)
const button = (name: RegExp | string) => screen.getByRole('button', { name })
const left = (id: string) =>
  Number.parseFloat(
    (button(new RegExp(`^${id},`)).closest('.room-stage__slot') as HTMLElement).style.left,
  )

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 900 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete document.documentElement.dataset.liveliness
})

test('members that join after others left never stand on the same spot', () => {
  saveLiveliness('calm')
  const { rerender } = render(view([member('lead'), member('builder'), member('reviewer')]))
  rerender(view([member('builder'), member('reviewer')]))
  rerender(view([member('builder'), member('reviewer'), member('designer')]))
  const spots = ['builder', 'reviewer', 'designer'].map(left)
  for (const [i, a] of spots.entries())
    for (const b of spots.slice(i + 1)) expect(Math.abs(a - b)).toBeGreaterThan(5)
})

test('out of view, everything pauses', () => {
  let notify: (entries: { isIntersecting: boolean }[]) => void = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof notify) {
        notify = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  render(view([member('builder', 'needs'), member('lead')]))
  const stage = screen.getByRole('group', { name: 'Room members' })
  expect(stage.classList.contains('room-stage--paused')).toBe(false)
  act(() => notify([{ isIntersecting: false }]))
  expect(stage.classList.contains('room-stage--paused')).toBe(true)
  act(() => notify([{ isIntersecting: true }]))
  expect(stage.classList.contains('room-stage--paused')).toBe(false)
  expect(css).toMatch(/\.room-stage--paused[^{]*\{[^}]*animation-play-state: paused !important/)
})

test('Still keeps the signs of a mood: the "!", thought dots and z’s show without motion', () => {
  saveLiveliness('still')
  render(
    view([member('a', 'needs'), member('b', 'think'), member('c', 'sleep'), member('d', 'sleep')]),
  )
  expect(button(/^a,/).querySelector('.room-stage__bang')).not.toBeNull()
  expect(button(/^b,/).querySelector('.room-stage__dots')).not.toBeNull()
  expect(button(/^d,/).querySelector('.room-stage__zzz')).not.toBeNull()
  // A z is visible on its own: only its animation fades it in and out.
  expect(css).toMatch(/\.room-stage__z \{[^}]*fill-opacity: 0\.[5-9]/)
})

test('clicking a member makes it say hi', () => {
  render(view([member('builder'), member('lead', 'rest')]))
  fireEvent.click(button(/^lead,/))
  expect(button(/^lead,/).querySelector('.room-stage__say')).not.toBeNull()
})

test('a quiet room puts resting members to sleep with z’s; a busy one stays up', () => {
  const members = [member('mark'), member('busy', 'work')]
  const { rerender } = render(view(members, { quiet: true }))
  expect(button(/^mark,/).querySelector('.room-stage__zzz')).not.toBeNull()
  expect(button(/^busy,/).querySelector('.room-stage__zzz')).toBeNull()
  rerender(view(members, { quiet: false }))
  expect(button(/^mark,/).querySelector('.room-stage__zzz')).toBeNull()
})
