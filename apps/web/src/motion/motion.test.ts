import { afterEach, describe, expect, it, vi } from 'vitest'
import { playMotion, prefersReducedMotion } from './motion.ts'

function mockReduce(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('motion gate', () => {
  it('reads the reduced-motion preference', () => {
    mockReduce(true)
    expect(prefersReducedMotion()).toBe(true)
    mockReduce(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('never plays (nor loads) anything with reduced motion', async () => {
    mockReduce(true)
    const play = vi.fn()
    playMotion(play)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(play).not.toHaveBeenCalled()
  })

  it('plays once the library has loaded, and a cancel before that stops it', async () => {
    mockReduce(false)
    const play = vi.fn()
    playMotion(play)
    const cancelled = vi.fn()
    playMotion(cancelled)()
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    expect(play.mock.calls[0]![0]).toHaveProperty('animate')
    expect(cancelled).not.toHaveBeenCalled()
  })
})
