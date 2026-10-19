import type { AgentStyle, PetActivity } from '@score/contract'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { saveLiveliness } from '../data/liveliness.ts'
import { SLEEP_AFTER_MS } from '../pets/pet-scheduler.ts'
import { PetAvatar, type PetAvatarProps } from './PetAvatar.tsx'

const css = readFileSync('src/components/pet-avatar.css', 'utf8')

function agent(...files: PetActivity[]): PetAvatarProps['agent'] {
  return {
    id: 'lead',
    name: 'lead',
    style: {
      color: '#6B4EFF',
      shape: 'star',
      pack: { rev: 'r1', activities: ['idle', ...files], name: null, credits: null, floor: 0 },
    } satisfies AgentStyle & { pack: NonNullable<AgentStyle['pack']> },
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  delete document.documentElement.dataset.liveliness
})

const imgs = () => [...document.querySelectorAll<HTMLImageElement>('img.pet-anim')]
const on = () => document.querySelector('img.pet-anim--on')?.getAttribute('data-anim')
const avatar = () => screen.getByRole('img', { name: 'lead' })

test('shows the idle file first, from the pack revision, with the agent’s mark as a badge', () => {
  render(<PetAvatar agent={agent('work')} />)
  expect(imgs().map((img) => img.getAttribute('src'))).toEqual([
    '/api/agents/lead/pack/idle?rev=r1',
  ])
  expect(on()).toBe('idle')
  expect(avatar().getAttribute('data-protected')).toBe('any')
  const badge = avatar().querySelector('.pet-badge .agent-glyph')!
  expect(badge.classList.contains('agent-glyph--cut')).toBe(true)
  expect(badge.getAttribute('aria-hidden')).toBe('true')
})

test('a file is fetched when its mood first comes, and the moods crossfade', () => {
  const { rerender } = render(<PetAvatar agent={agent('work', 'think')} />)
  expect(imgs()).toHaveLength(1)
  rerender(<PetAvatar agent={agent('work', 'think')} activity="working" />)
  expect(imgs().map((img) => img.dataset.anim)).toEqual(['idle', 'work'])
  expect(on()).toBe('work')
  // Both stay in the page so the crossfade is a change of opacity; only one is on.
  expect(document.querySelectorAll('.pet-anim--on')).toHaveLength(1)
  expect(css).toMatch(/\.pet-anim\s*\{[^}]*opacity: 0;[^}]*transition: opacity 0\.35s/)
  rerender(<PetAvatar agent={agent('work', 'think')} activity="idle" />)
  expect(on()).toBe('idle')
  expect(imgs()).toHaveLength(2)
})

test('thinking and needs you fall back to idle with Score’s overlays when the pack has no such file', () => {
  const { rerender } = render(<PetAvatar agent={agent()} activity="thinking" />)
  expect(on()).toBe('idle')
  expect(avatar().querySelectorAll('.pet-dot')).toHaveLength(3)
  expect(avatar().querySelector('.pet-alert')).toBeNull()
  rerender(<PetAvatar agent={agent()} activity="needs" />)
  expect(avatar().querySelector('.pet-alert-text')?.textContent).toBe('!')
  expect(avatar().querySelector('.pet-stage--hop')).not.toBeNull()
  expect(avatar().querySelector('.pet-dot')).toBeNull()
  rerender(<PetAvatar agent={agent()} activity="working" />)
  expect(avatar().querySelector('.pet-fx')).toBeNull()
})

test('with the files, the animation shows the mood and no overlay is drawn', () => {
  const { rerender } = render(<PetAvatar agent={agent('think', 'needs')} activity="thinking" />)
  expect(on()).toBe('think')
  expect(avatar().querySelector('.pet-fx')).toBeNull()
  rerender(<PetAvatar agent={agent('think', 'needs')} activity="needs" />)
  expect(on()).toBe('needs')
  expect(avatar().querySelector('.pet-fx')).toBeNull()
  expect(avatar().querySelector('.pet-stage--hop')).toBeNull()
})

test('pointing at it plays greet, or says hi without one, for a moment', () => {
  const { rerender } = render(<PetAvatar agent={agent('greet')} />)
  fireEvent.pointerEnter(avatar())
  expect(on()).toBe('greet')
  act(() => vi.advanceTimersByTime(1300))
  expect(on()).toBe('idle')
  rerender(<PetAvatar agent={agent()} />)
  fireEvent.pointerEnter(avatar())
  expect(avatar().querySelector('.pet-say-text')?.textContent).toBe('hi!')
  act(() => vi.advanceTimersByTime(1300))
  expect(avatar().querySelector('.pet-say')).toBeNull()
})

test('clicking plays happy, or raises a heart and a bounce without one', () => {
  const { unmount } = render(<PetAvatar agent={agent('happy')} />)
  fireEvent.click(avatar())
  expect(on()).toBe('happy')
  unmount()
  render(<PetAvatar agent={agent()} />)
  fireEvent.click(avatar())
  expect(avatar().querySelector('.pet-heart-shape')).not.toBeNull()
  expect(avatar().querySelector('.pet-stage--love')).not.toBeNull()
  act(() => vi.advanceTimersByTime(1300))
  expect(avatar().querySelector('.pet-heart')).toBeNull()
})

test('Lively: after a while without attention it sleeps (the file, or z’s over idle)', () => {
  const { rerender } = render(<PetAvatar agent={agent('sleep')} />)
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS))
  expect(on()).toBe('sleep')
  rerender(<PetAvatar agent={agent()} activity="working" />)
  expect(on()).toBe('idle')
  rerender(<PetAvatar agent={agent()} />)
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS))
  expect(avatar().querySelectorAll('.pet-z')).toHaveLength(3)
})

test('Calm: the mood plays, the greeting works, but there is no sleep and no break', () => {
  saveLiveliness('calm')
  render(<PetAvatar agent={agent('sleep', 'walk', 'greet')} />)
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS * 3))
  expect(on()).toBe('idle')
  fireEvent.pointerEnter(avatar())
  expect(on()).toBe('greet')
})

test('choosing Calm while it sleeps wakes it', () => {
  const { unmount } = render(<PetAvatar agent={agent('sleep')} />)
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS))
  expect(on()).toBe('sleep')
  act(() => saveLiveliness('calm'))
  expect(on()).toBe('idle')
  unmount()
})

test('a hidden tab stops the timers', () => {
  let state: DocumentVisibilityState = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
  render(<PetAvatar agent={agent('sleep')} />)
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS - 1000))
  state = 'hidden'
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  act(() => vi.advanceTimersByTime(SLEEP_AFTER_MS * 2))
  expect(on()).toBe('idle')
})

test('Still shows one still frame on a canvas, with no animated image and no greeting', () => {
  saveLiveliness('still')
  const draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage: draw }) as never,
  )
  const loads: (() => void)[] = []
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 120
      naturalHeight = 160
      onload: (() => void) | null = null
      set src(_value: string) {
        loads.push(() => this.onload?.())
      }
    },
  )
  const { rerender } = render(<PetAvatar agent={agent('work')} />)
  expect(imgs()).toHaveLength(0)
  act(() => loads.forEach((load) => load()))
  const canvas = avatar().querySelector('canvas')!
  expect([canvas.width, canvas.height]).toEqual([120, 160])
  expect(draw).toHaveBeenCalledTimes(1)
  fireEvent.pointerEnter(avatar())
  fireEvent.click(avatar())
  expect(avatar().querySelector('.pet-fx')).toBeNull()
  // The frame of the mood's own file.
  rerender(<PetAvatar agent={agent('work')} activity="working" />)
  expect(avatar().querySelectorAll('canvas')).toHaveLength(1)
  expect(avatar().classList.contains('pet-avatar--still')).toBe(true)
})

test('reduced motion is Still', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  render(<PetAvatar agent={agent()} />)
  expect(imgs()).toHaveLength(0)
  expect(avatar().querySelector('canvas')).not.toBeNull()
})

test('the floor lifts the character, and the avatar is named for assistive technology or hidden from it', () => {
  const lifted = agent()
  lifted.style.pack.floor = 0.03
  const { container, rerender } = render(<PetAvatar agent={lifted} />)
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--pet-floor')).toBe(
    '0.03',
  )
  expect(css).toMatch(/bottom: calc\(8% \+ var\(--pet-floor, 0\) \* 80%\)/)
  rerender(<PetAvatar agent={lifted} decorative />)
  expect(screen.queryByRole('img')).toBeNull()
  expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
})

test('only transform and fill-opacity are animated (the protected layer pins opacity), and Still stills everything', () => {
  const properties = new Set<string>()
  for (const block of css.matchAll(/@keyframes [\w-]+\s*\{((?:\s*[\d.%,\s]+\{[^}]*\})+)\s*\}/g))
    for (const declaration of block[1]!.matchAll(/([\w-]+):/g)) properties.add(declaration[1]!)
  expect([...properties].sort()).toEqual(['fill-opacity', 'transform'])
  expect(css).toMatch(
    /html\[data-liveliness='still'\] \.pet-avatar \*,[^{]*\{\s*animation: none !important/,
  )
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pet-avatar,\s*\.pet-avatar \*\s*\{\s*animation: none !important/,
  )
})
