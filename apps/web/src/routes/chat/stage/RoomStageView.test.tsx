import type { AgentSummary } from '@score/contract'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveLiveliness } from '../../../data/liveliness.ts'
import { RoomStageView, type StageMember } from './RoomStageView.tsx'
import type { StageMood } from './stage-mood.ts'

const agent = (id: string, color: string): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: { color, shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const member = (id: string, mood: StageMood = 'rest'): StageMember => ({
  agent: agent(id, '#6B4EFF'),
  mood,
})

function stageWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: width })
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  stageWidth(900)
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

const group = () => screen.getByRole('group', { name: 'Room members' })
const button = (name: RegExp | string) => screen.getByRole('button', { name })

test('the strip is a protected, labelled group with one button per member that says its mood', () => {
  render(
    <RoomStageView
      roomId="room-1"
      members={[member('lead'), member('builder', 'needs'), member('reviewer', 'work')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  expect(group().getAttribute('data-protected')).toBe('any')
  expect(group().classList.contains('room-stage')).toBe(true)
  expect(within(group()).getAllByRole('button')).toHaveLength(3)
  expect(button('lead, resting')).toBeDefined()
  expect(button('builder, waiting for you').getAttribute('data-mood')).toBe('needs')
  expect(button('reviewer, working').getAttribute('data-mood')).toBe('work')
})

test('every member is its mark with its name below', () => {
  render(
    <RoomStageView
      roomId="room-1"
      members={[member('builder', 'rest'), member('lead')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  const mark = button(/^lead/)
  expect(mark.querySelector('img')).toBeNull()
  expect(mark.querySelector('.room-stage__mark .agent-glyph')).not.toBeNull()
  expect(mark.querySelector('.room-stage__name')?.textContent).toBe('lead')
})

test('moods show Score’s own signs: thought dots, the "!" and the z’s', () => {
  const { rerender } = render(
    <RoomStageView
      roomId="r"
      members={[member('builder', 'rest')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  const show = (mood: StageMood) =>
    rerender(
      <RoomStageView
        roomId="r"
        members={[member('builder', mood)]}
        handoff={null}
        onMention={() => {}}
      />,
    )
  show('think')
  expect(button(/^builder/).querySelector('.room-stage__dots')).not.toBeNull()
  show('needs')
  expect(button(/^builder/).querySelector('.room-stage__bang')).not.toBeNull()
  show('sleep')
  expect(button(/^builder/).querySelector('.room-stage__zzz')).not.toBeNull()
})

test('a member waiting for you steps to the front; its mark is marked for hopping', () => {
  render(
    <RoomStageView
      roomId="r"
      members={[member('lead'), member('builder', 'needs'), member('reviewer', 'work')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  expect(button(/^builder/).getAttribute('data-front')).toBe('true')
  expect(button(/^lead/).getAttribute('data-front')).toBeNull()
  expect(button(/^builder/).querySelector('.room-stage__bang')).not.toBeNull()
  expect(button(/^builder/).querySelector('.room-stage__mark--hop')).not.toBeNull()
})

test('clicking a member asks for its mention and it says hi beside its head', () => {
  const onMention = vi.fn()
  render(
    <RoomStageView
      roomId="r"
      members={[member('lead'), member('builder')]}
      handoff={null}
      onMention={onMention}
    />,
  )
  fireEvent.click(button(/^builder/))
  expect(onMention).toHaveBeenCalledWith('builder')
  expect(button(/^builder/).querySelector('.room-stage__say')?.textContent).toContain('hi!')
  act(() => {
    vi.advanceTimersByTime(1500)
  })
  expect(button(/^builder/).querySelector('.room-stage__say')).toBeNull()
})

test('a hand-off turns the two toward each other', () => {
  render(
    <RoomStageView
      roomId="r"
      members={[member('lead'), member('builder'), member('reviewer')]}
      handoff={{ id: 'm1', from: 'builder', to: 'lead' }}
      onMention={() => {}}
    />,
  )
  // Lead stands left of builder: lead looks right, builder looks left.
  expect(button(/^lead/).getAttribute('data-facing')).toBe('right')
  expect(button(/^builder/).getAttribute('data-facing')).toBe('left')
})

test('Still shows no motion class on the strip', () => {
  saveLiveliness('still')
  render(
    <RoomStageView
      roomId="r"
      members={[member('builder', 'work'), member('lead')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  expect(group().getAttribute('data-liveliness')).toBe('still')
  expect(group().querySelectorAll('img')).toHaveLength(0)
})

test('on a phone at most five members show, then a +N chip that opens the member list', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(width < 560px)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const onMention = vi.fn()
  render(
    <RoomStageView
      roomId="r"
      members={ids.map((id) => member(id))}
      handoff={null}
      onMention={onMention}
    />,
  )
  expect(group().querySelectorAll('.room-stage__actor')).toHaveLength(5)
  const chip = screen.getByRole('button', { name: '2 more members' })
  expect(chip.textContent).toBe('+2')
  expect(chip.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(chip)
  expect(chip.getAttribute('aria-expanded')).toBe('true')
  const list = screen.getByRole('list', { name: 'All members' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(7)
  fireEvent.click(within(list).getByRole('button', { name: /^f/ }))
  expect(onMention).toHaveBeenCalledWith('f')
})

test('there is no +N chip on a desk, where everyone shows', () => {
  render(
    <RoomStageView
      roomId="r"
      members={['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => member(id))}
      handoff={null}
      onMention={() => {}}
    />,
  )
  expect(group().querySelectorAll('.room-stage__actor')).toHaveLength(7)
  expect(screen.queryByRole('button', { name: /more members/ })).toBeNull()
})
