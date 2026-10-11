import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const waapiAnimate = vi.hoisted(() => vi.fn(() => ({ cancel: vi.fn() })))
const animate = vi.hoisted(() => vi.fn(() => ({ cancel: vi.fn() })))
const createDrawable = vi.hoisted(() => vi.fn((el: Element) => [el]))
const reduced = vi.hoisted(() => ({ on: false }))
vi.mock('../../motion/motion.ts', async (original) => ({
  ...(await original<typeof import('../../motion/motion.ts')>()),
  playMotion: (play: (anime: unknown) => (() => void) | void) =>
    reduced.on
      ? () => {}
      : (play({ animate, waapi: { animate: waapiAnimate }, svg: { createDrawable } }) ??
        (() => {})),
}))

import { useTimelineArrivals } from './use-timeline-arrivals.ts'

function plotWith(blocks: string[], links: string[]) {
  const root = document.createElement('div')
  for (const id of blocks) {
    const el = document.createElement('button')
    el.setAttribute('data-arrive-block', id)
    root.appendChild(el)
  }
  for (const id of links) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    el.setAttribute('data-arrive-link', id)
    root.appendChild(el)
  }
  return { current: root }
}

type Props = { blocks: string[]; links: { id: string; kind: string }[]; width: number }
const run = (initial: Props, plot: { current: HTMLElement }) =>
  renderHook((p: Props) => useTimelineArrivals(plot, p.blocks, p.links, p.width), {
    initialProps: initial,
  })

beforeEach(() => {
  waapiAnimate.mockClear()
  animate.mockClear()
  createDrawable.mockClear()
  reduced.on = false
})

describe('useTimelineArrivals', () => {
  it('does not animate the first render or an unchanged timeline', () => {
    const plot = plotWith(['a'], ['l1'])
    const view = run({ blocks: ['a'], links: [{ id: 'l1', kind: 'handoff' }], width: 900 }, plot)
    view.rerender({ blocks: ['a'], links: [{ id: 'l1', kind: 'handoff' }], width: 900 })
    expect(waapiAnimate).not.toHaveBeenCalled()
    expect(animate).not.toHaveBeenCalled()
  })

  it('grows a new block in and draws a new hand-off', () => {
    const plot = plotWith(['a', 'b'], ['l1'])
    const view = run({ blocks: ['a'], links: [], width: 900 }, plot)
    view.rerender({ blocks: ['a', 'b'], links: [{ id: 'l1', kind: 'handoff' }], width: 900 })
    expect(waapiAnimate).toHaveBeenCalledTimes(1)
    expect(createDrawable).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it('treats a width change as layout, and does nothing with reduced motion', () => {
    const plot = plotWith(['a', 'g'], [])
    const view = run({ blocks: ['a'], links: [], width: 900 }, plot)
    view.rerender({ blocks: ['a', 'g'], links: [], width: 600 })
    expect(waapiAnimate).not.toHaveBeenCalled()
    reduced.on = true
    view.rerender({ blocks: ['a', 'g', 'h'], links: [], width: 600 })
    expect(waapiAnimate).not.toHaveBeenCalled()
  })
})
