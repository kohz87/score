import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ reduced: false }))
const animate = vi.hoisted(() => vi.fn(() => ({ cancel: vi.fn() })))
vi.mock('./motion.ts', async (original) => ({
  ...(await original<typeof import('./motion.ts')>()),
  prefersReducedMotion: () => state.reduced,
  playMotion: (play: (anime: { waapi: { animate: typeof animate } }) => (() => void) | void) =>
    play({ waapi: { animate } }) ?? (() => {}),
}))

import { Arrival, resetArrivals } from './Arrival.tsx'

beforeEach(() => {
  resetArrivals()
  animate.mockClear()
  state.reduced = false
})

describe('Arrival', () => {
  it('rises in and pulses once, then stays put on re-renders and remounts', () => {
    const view = render(<Arrival arrivalId="a">card</Arrival>)
    // One entrance and one pulse.
    expect(animate).toHaveBeenCalledTimes(2)
    view.rerender(<Arrival arrivalId="a">card changed</Arrival>)
    expect(animate).toHaveBeenCalledTimes(2)
    view.unmount()
    render(<Arrival arrivalId="a">card</Arrival>)
    expect(animate).toHaveBeenCalledTimes(2)
    render(<Arrival arrivalId="b">other</Arrival>)
    expect(animate).toHaveBeenCalledTimes(4)
  })

  it('does nothing without an id, and nothing at all with reduced motion', () => {
    const { container } = render(<Arrival arrivalId={null}>card</Arrival>)
    expect(animate).not.toHaveBeenCalled()
    expect(container.querySelector('section')!.style.opacity).toBe('')
    state.reduced = true
    const reduced = render(<Arrival arrivalId="c">card</Arrival>)
    expect(animate).not.toHaveBeenCalled()
    expect(reduced.container.querySelector('section')!.style.opacity).toBe('')
  })
})
