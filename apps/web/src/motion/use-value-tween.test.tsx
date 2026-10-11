import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const animate = vi.hoisted(() =>
  vi.fn((_state: { value: number }, params: { value: number; onUpdate: () => void }) => {
    params.onUpdate()
    return { cancel: vi.fn() }
  }),
)
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('./motion.ts', async (original) => ({
  ...(await original<typeof import('./motion.ts')>()),
  playMotion: (play: (anime: { animate: typeof animate }) => (() => void) | void) =>
    reduced.on ? () => {} : (play({ animate }) ?? (() => {})),
}))

import { useValueTween } from './use-value-tween.ts'

beforeEach(() => {
  animate.mockClear()
  reduced.on = false
})

describe('useValueTween', () => {
  it('does not animate the first render or an unchanged value', () => {
    const apply = vi.fn()
    const view = renderHook(({ value }) => useValueTween(value, apply), {
      initialProps: { value: 0.5 },
    })
    view.rerender({ value: 0.5 })
    expect(animate).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('animates from the shown value to the new one', () => {
    const apply = vi.fn()
    const view = renderHook(({ value }) => useValueTween(value, apply), {
      initialProps: { value: 0.8 },
    })
    view.rerender({ value: 0.2 })
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.calls[0]![0].value).toBe(0.8)
    expect(animate.mock.calls[0]![1].value).toBe(0.2)
    expect(apply).toHaveBeenCalledWith(0.8)
  })

  it('does nothing with reduced motion or when disabled', () => {
    const apply = vi.fn()
    reduced.on = true
    const view = renderHook(({ value }) => useValueTween(value, apply), {
      initialProps: { value: 0.8 },
    })
    view.rerender({ value: 0.2 })
    expect(animate).not.toHaveBeenCalled()
    reduced.on = false
    const off = renderHook(({ value }) => useValueTween(value, apply, { enabled: false }), {
      initialProps: { value: 0.8 },
    })
    off.rerender({ value: 0.2 })
    expect(animate).not.toHaveBeenCalled()
  })
})
