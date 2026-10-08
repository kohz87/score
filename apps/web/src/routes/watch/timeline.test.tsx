import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { WatchMarker } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { ScrubTimeline, type ScrubTimelineProps } from './ScrubTimeline.tsx'

afterEach(cleanup)

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8, 21, 0, seconds)).toISOString()
const markers: WatchMarker[] = [
  { seq: 1, at: at(0), kind: 'command' },
  { seq: 2, at: at(30), kind: 'file' },
  { seq: 3, at: at(60), kind: 'browser' },
  { seq: 3, at: at(61), kind: 'asked' },
]

function timeline(props: Partial<ScrubTimelineProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onLive: vi.fn(),
    onBack: vi.fn(),
    onTogglePlay: vi.fn(),
  }
  const view = render(
    <ScrubTimeline
      agent={{ name: 'builder' }}
      markers={markers}
      cursor={null}
      playing={false}
      {...handlers}
      {...props}
    />,
  )
  return { ...handlers, ...view }
}

test('markers are coloured by kind and the legend names each kind', () => {
  timeline()
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  const buttons = within(track).getAllByRole('button')
  expect(buttons.map((button) => button.className.match(/watch-marker--(\w+)/)![1])).toEqual([
    'command',
    'file',
    'browser',
    'asked',
  ])
  for (const label of ['Command', 'File edit', 'Browser', 'Asked you'])
    expect(screen.getByText(label)).toBeTruthy()
  expect(
    screen.getByText(
      /Drag back to replay anything they did\. builder keeps working while you watch the past\./,
    ),
  ).toBeTruthy()
})

test('choosing a marker replays it, and Live is pressed only while live', () => {
  const { onSelect, rerender, onLive } = timeline()
  expect(screen.getByRole('button', { name: 'Back to live' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  fireEvent.click(screen.getByRole('button', { name: /^File edit at/ }))
  expect(onSelect).toHaveBeenCalledWith(1)
  rerender(
    <ScrubTimeline
      agent={{ name: 'builder' }}
      markers={markers}
      cursor={1}
      playing={false}
      onSelect={onSelect}
      onLive={onLive}
      onBack={vi.fn()}
      onTogglePlay={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: 'Back to live' }).getAttribute('aria-pressed')).toBe(
    'false',
  )
  expect(screen.getByRole('button', { name: /^File edit at/ }).getAttribute('aria-current')).toBe(
    'true',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
  expect(onLive).toHaveBeenCalled()
})

test('arrow keys move between markers, End returns to live and past the last marker is live', () => {
  const { onSelect, onLive } = timeline({ cursor: 1 })
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  fireEvent.keyDown(track, { key: 'ArrowLeft' })
  expect(onSelect).toHaveBeenLastCalledWith(0)
  fireEvent.keyDown(track, { key: 'ArrowRight' })
  expect(onSelect).toHaveBeenLastCalledWith(2)
  fireEvent.keyDown(track, { key: 'Home' })
  expect(onSelect).toHaveBeenLastCalledWith(0)
  fireEvent.keyDown(track, { key: 'End' })
  expect(onLive).toHaveBeenCalledTimes(1)
  cleanup()
  const last = timeline({ cursor: 3 })
  fireEvent.keyDown(screen.getByRole('group', { name: 'Replay timeline' }), { key: 'ArrowRight' })
  expect(last.onLive).toHaveBeenCalled()
})

test('the focusable stop is the replayed marker, or the newest while live', () => {
  const { unmount } = timeline()
  const stops = () =>
    within(screen.getByRole('group', { name: 'Replay timeline' }))
      .getAllByRole('button')
      .map((button) => button.tabIndex)
  expect(stops()).toEqual([-1, -1, -1, 0])
  unmount()
  timeline({ cursor: 0 })
  expect(stops()).toEqual([0, -1, -1, -1])
})

test('rewind and play buttons call their handlers and the play label follows the state', () => {
  const view = timeline({ cursor: 2, playing: false })
  fireEvent.click(screen.getByRole('button', { name: 'Back 30 seconds' }))
  expect(view.onBack).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  expect(view.onTogglePlay).toHaveBeenCalled()
  view.unmount()
  timeline({ cursor: 2, playing: true })
  expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy()
  cleanup()
  timeline()
  expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy()
})
