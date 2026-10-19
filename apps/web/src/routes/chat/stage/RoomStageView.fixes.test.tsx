import type { AgentSummary, PetActivity } from '@score/contract'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveLiveliness } from '../../../data/liveliness.ts'
import { RoomStageView, type StageMember } from './RoomStageView.tsx'
import type { StageMood } from './stage-mood.ts'

const css = readFileSync('src/routes/chat/stage/room-stage.css', 'utf8')
const agent = (id: string, files?: PetActivity[]): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: {
    color: '#6B4EFF',
    shape: 'circle-dot',
    ...(files
      ? { pack: { rev: 'r1', activities: ['idle', ...files], name: null, credits: null, floor: 0 } }
      : {}),
  },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const member = (id: string, mood: StageMood = 'rest', files?: PetActivity[]): StageMember => ({
  agent: agent(id, files),
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

test('out of view, everything pauses: still frames, paused animations', () => {
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
  render(view([member('builder', 'needs', ['needs']), member('lead')]))
  const stage = screen.getByRole('group', { name: 'Room members' })
  expect(stage.querySelectorAll('img.room-stage__anim').length).toBeGreaterThan(0)
  expect(stage.classList.contains('room-stage--paused')).toBe(false)
  act(() => notify([{ isIntersecting: false }]))
  expect(stage.querySelectorAll('img')).toHaveLength(0)
  expect(button(/^builder,/).querySelector('canvas.room-stage__anim--on')).not.toBeNull()
  expect(stage.classList.contains('room-stage--paused')).toBe(true)
  act(() => notify([{ isIntersecting: true }]))
  expect(stage.querySelectorAll('img.room-stage__anim').length).toBeGreaterThan(0)
  expect(stage.classList.contains('room-stage--paused')).toBe(false)
  expect(css).toMatch(/\.room-stage--paused[^{]*\{[^}]*animation-play-state: paused !important/)
})

test('a break or stroll does not come due while the stage was paused', () => {
  let n = 0
  vi.spyOn(Math, 'random').mockImplementation(() => (n++ * 0.381966) % 1)
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
  render(view([member('lead', 'rest', ['walk']), member('builder', 'rest', ['walk'])]))
  // Nearly due (first deadline is within 8 s), then out of view for ten minutes.
  act(() => {
    vi.advanceTimersByTime(2500)
  })
  act(() => notify([{ isIntersecting: false }]))
  act(() => {
    vi.advanceTimersByTime(600_000)
  })
  act(() => notify([{ isIntersecting: true }]))
  const modes = () =>
    ['lead', 'builder'].map((id) => button(new RegExp(`^${id},`)).getAttribute('data-mode'))
  act(() => {
    vi.advanceTimersByTime(300)
  })
  expect(modes()).toEqual(['idle', 'idle'])
})

test('Still keeps the signs of a mood: the "!", thought dots and z’s show without motion', () => {
  saveLiveliness('still')
  render(
    view([
      member('a', 'needs', ['needs']),
      member('b', 'think', ['work']),
      member('c', 'sleep', ['sleep']),
      member('d', 'sleep'),
    ]),
  )
  expect(button(/^a,/).querySelector('.room-stage__bang')).not.toBeNull()
  expect(button(/^b,/).querySelector('.room-stage__dots')).not.toBeNull()
  expect(button(/^d,/).querySelector('.room-stage__zzz')).not.toBeNull()
  // A z is visible on its own: only its animation fades it in and out.
  expect(css).toMatch(/\.room-stage__z \{[^}]*fill-opacity: 0\.[5-9]/)
})

test('clicking a pet with a greet file plays it once, then back; others say hi', () => {
  render(view([member('builder', 'rest', ['greet']), member('lead', 'rest', ['work'])]))
  const on = () =>
    button(/^builder,/)
      .querySelector('.room-stage__anim--on')
      ?.getAttribute('data-anim')
  fireEvent.click(button(/^builder,/))
  expect(on()).toBe('greet')
  expect(button(/^builder,/).querySelector('.room-stage__say')).toBeNull()
  act(() => {
    vi.advanceTimersByTime(1500)
  })
  expect(on()).toBe('idle')
  fireEvent.click(button(/^lead,/))
  expect(button(/^lead,/).querySelector('.room-stage__say')).not.toBeNull()
})

test('a quiet room puts resting members to sleep: the sleep file, or z’s; a busy one stays up', () => {
  const members = [
    member('pet', 'rest', ['sleep']),
    member('bare', 'rest', ['work']),
    member('mark'),
    member('busy', 'work', ['sleep']),
  ]
  const { rerender } = render(view(members, { quiet: true }))
  const on = (id: string) =>
    button(new RegExp(`^${id},`))
      .querySelector('.room-stage__anim--on')
      ?.getAttribute('data-anim')
  expect(on('pet')).toBe('sleep')
  expect(button(/^bare,/).querySelector('.room-stage__zzz')).not.toBeNull()
  expect(button(/^mark,/).querySelector('.room-stage__zzz')).not.toBeNull()
  expect(on('busy')).toBe('idle')
  expect(button(/^busy,/).querySelector('.room-stage__zzz')).toBeNull()
  rerender(view(members, { quiet: false }))
  expect(on('pet')).toBe('idle')
  expect(button(/^mark,/).querySelector('.room-stage__zzz')).toBeNull()
})
