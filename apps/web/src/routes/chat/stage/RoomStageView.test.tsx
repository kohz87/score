import type { AgentSummary, PetActivity } from '@score/contract'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveLiveliness } from '../../../data/liveliness.ts'
import { RoomStageView, type StageMember } from './RoomStageView.tsx'
import type { StageMood } from './stage-mood.ts'

const agent = (id: string, color: string, files?: PetActivity[]): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: {
    color,
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
  agent: agent(id, '#6B4EFF', files),
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
      members={[member('lead'), member('builder', 'needs', ['needs']), member('reviewer', 'work')]}
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

test('a pet plays its pack with its mark as a badge and its name below; an agent without a pack is its mark', () => {
  render(
    <RoomStageView
      roomId="room-1"
      members={[member('builder', 'rest', ['work']), member('lead')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  const pet = button(/^builder/)
  const imgs = [...pet.querySelectorAll<HTMLImageElement>('img.room-stage__anim')]
  expect(imgs.map((img) => img.getAttribute('src'))).toEqual([
    '/api/agents/builder/pack/idle?rev=r1',
  ])
  expect(imgs[0]!.classList.contains('room-stage__anim--on')).toBe(true)
  expect(pet.querySelector('.room-stage__badge .agent-glyph')).not.toBeNull()
  expect(pet.querySelector('.room-stage__name')?.textContent).toBe('builder')
  const mark = button(/^lead/)
  expect(mark.querySelector('img')).toBeNull()
  expect(mark.querySelector('.room-stage__mark .agent-glyph')).not.toBeNull()
  expect(mark.querySelector('.room-stage__badge')).toBeNull()
  expect(mark.querySelector('.room-stage__name')?.textContent).toBe('lead')
})

test('moods crossfade to the pack’s files, and fall back to idle plus an overlay where it has none', () => {
  const { rerender } = render(
    <RoomStageView
      roomId="r"
      members={[member('builder', 'rest', ['work', 'needs'])]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  const on = () =>
    button(/^builder/)
      .querySelector('img.room-stage__anim--on')
      ?.getAttribute('data-anim')
  const show = (mood: StageMood) =>
    rerender(
      <RoomStageView
        roomId="r"
        members={[member('builder', mood, ['work', 'needs'])]}
        handoff={null}
        onMention={() => {}}
      />,
    )
  expect(on()).toBe('idle')
  show('work')
  expect(on()).toBe('work')
  expect(button(/^builder/).querySelectorAll('img.room-stage__anim')).toHaveLength(2)
  show('think')
  expect(on()).toBe('idle')
  expect(button(/^builder/).querySelector('.room-stage__dots')).not.toBeNull()
  show('needs')
  expect(on()).toBe('needs')
  expect(button(/^builder/).querySelector('.room-stage__bang')).not.toBeNull()
  show('sleep')
  expect(button(/^builder/).querySelector('.room-stage__zzz')).not.toBeNull()
})

test('a member waiting for you steps to the front; a mark in that state is marked for hopping', () => {
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
  expect(button(/^builder/).querySelector('.agent-glyph--needs')).not.toBeNull()
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
      members={[
        member('lead', 'rest', ['walk']),
        member('builder', 'rest', ['walk']),
        member('reviewer'),
      ]}
      handoff={{ id: 'm1', from: 'builder', to: 'lead' }}
      onMention={() => {}}
    />,
  )
  // Lead stands left of builder: lead looks right, builder looks left.
  expect(button(/^lead/).getAttribute('data-facing')).toBe('right')
  expect(button(/^builder/).getAttribute('data-facing')).toBe('left')
})

test('Lively members wander and break; Calm and Still keep where they are', () => {
  let n = 0
  vi.spyOn(Math, 'random').mockImplementation(() => (n++ * 0.381966) % 1)
  const members = [
    member('lead', 'rest', ['walk', 'coffee']),
    member('builder', 'rest', ['walk']),
    member('reviewer', 'work', ['walk']),
  ]
  const modes = () =>
    ['lead', 'builder', 'reviewer'].map((id) =>
      button(new RegExp(`^${id}`)).getAttribute('data-mode'),
    )
  const { unmount } = render(
    <RoomStageView roomId="r" members={members} handoff={null} onMention={() => {}} />,
  )
  let walked = false
  for (let second = 0; second < 40 && !walked; second += 1) {
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    walked = modes().includes('walk')
  }
  expect(walked).toBe(true)
  // Only resting members wander.
  expect(modes()[2]).toBe('idle')
  unmount()
  for (const choice of ['calm', 'still'] as const) {
    saveLiveliness(choice)
    const view = render(
      <RoomStageView roomId="r" members={members} handoff={null} onMention={() => {}} />,
    )
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(modes()).toEqual(['idle', 'idle', 'idle'])
    view.unmount()
  }
})

test('Still shows still first frames and no animated image at all', () => {
  saveLiveliness('still')
  render(
    <RoomStageView
      roomId="r"
      members={[member('builder', 'work', ['work']), member('lead')]}
      handoff={null}
      onMention={() => {}}
    />,
  )
  expect(group().querySelectorAll('img')).toHaveLength(0)
  expect(button(/^builder/).querySelector('canvas.room-stage__anim--on')).not.toBeNull()
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
