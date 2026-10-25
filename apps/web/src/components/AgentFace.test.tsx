import { readFileSync } from 'node:fs'
import { ShapeSchema } from '@score/contract'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentGlyph } from './AgentGlyph.tsx'
import { AgentFacesContext } from './agent-faces-context.ts'
import type { FaceMood } from './agent-face.ts'

const css = readFileSync('src/components/agent-face.css', 'utf8')
const agent = (shape = 'triangle' as (typeof ShapeSchema.options)[number], id = 'builder') => ({
  id,
  name: id,
  style: { color: '#1E88FF', shape },
})
const withFaces = (node: React.ReactNode) => <AgentFacesContext value>{node}</AgentFacesContext>

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('outside the new shell no glyph has eyes', () => {
  const { container } = render(<AgentGlyph agent={agent()} mood="needs" lively />)
  expect(container.querySelector('.agent-face, .agent-glyph__body')).toBeNull()
  expect(container.firstElementChild?.getAttribute('data-face')).toBeNull()
})

test.each(ShapeSchema.options)(
  '%s has two blank sockets in the new shell, at every size',
  (shape) => {
    for (const size of ['xs', 'sm', 'md', 'lg'] as const) {
      const { container, unmount } = render(
        withFaces(<AgentGlyph agent={agent(shape)} size={size} />),
      )
      expect(container.querySelectorAll('.agent-face__socket')).toHaveLength(2)
      // Blank: no pupils, highlights or lids as separate shapes.
      expect(
        container.querySelectorAll('.agent-face circle, .agent-face rect, .agent-face image'),
      ).toHaveLength(0)
      expect(container.querySelector('.agent-face')?.getAttribute('aria-hidden')).toBe('true')
      // The silhouette is still there, with its own geometry.
      expect(container.querySelector('.agent-glyph__solid, .agent-glyph__ring')).not.toBeNull()
      unmount()
    }
  },
)

test('the circle-dot ring loses its centre dot to the eyes, other shapes keep their geometry', () => {
  const ring = render(withFaces(<AgentGlyph agent={agent('circle-dot')} />))
  expect(ring.container.querySelectorAll('.agent-glyph__solid')).toHaveLength(0)
  expect(ring.container.querySelectorAll('.agent-glyph__ring')).toHaveLength(1)
  cleanup()
  const tri = render(withFaces(<AgentGlyph agent={agent('triangle')} />))
  expect(tri.container.querySelector('path.agent-glyph__solid')?.getAttribute('d')).toBe(
    'M10 3 L17.5 16 H2.5 Z',
  )
})

test.each(['idle', 'resting', 'thinking', 'working', 'needs', 'done'] as FaceMood[])(
  'mood %s is drawn',
  (mood) => {
    const { container } = render(withFaces(<AgentGlyph agent={agent()} mood={mood} />))
    expect(container.firstElementChild?.getAttribute('data-face')).toBe(mood)
    expect(container.querySelector(`.agent-face--${mood}`)).not.toBeNull()
    expect(
      container.querySelectorAll(mood === 'done' ? '.agent-face__arc' : '.agent-face__socket'),
    ).toHaveLength(2)
  },
)

test('xs glyphs are static, sm and up animate', () => {
  const xs = render(withFaces(<AgentGlyph agent={agent()} size="xs" />))
  expect(xs.container.querySelector('.agent-face--animated')).toBeNull()
  cleanup()
  const sm = render(withFaces(<AgentGlyph agent={agent()} size="sm" />))
  expect(sm.container.querySelector('.agent-face--animated')).not.toBeNull()
})

test('each agent gets its own timing from a hash of its id', () => {
  const style = (id: string) => {
    const { container, unmount } = render(withFaces(<AgentGlyph agent={agent('triangle', id)} />))
    const value = (container.querySelector('.agent-face') as SVGElement).style.cssText
    unmount()
    return value
  }
  expect(style('builder')).not.toBe(style('reviewer'))
  expect(style('builder')).toBe(style('builder'))
})

test('forty glyphs start no timers and no listeners', () => {
  const interval = vi.spyOn(globalThis, 'setInterval')
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const listen = vi.spyOn(window, 'addEventListener')
  const before = timeout.mock.calls.length
  render(
    withFaces(
      <>
        {Array.from({ length: 40 }, (_, index) => (
          <AgentGlyph key={index} agent={agent('square', `a${index}`)} size="md" />
        ))}
      </>,
    ),
  )
  expect(interval).not.toHaveBeenCalled()
  expect(timeout.mock.calls.length).toBe(before)
  expect(listen.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0)
  interval.mockRestore()
  timeout.mockRestore()
  listen.mockRestore()
})

test('reduced motion turns every face animation off', () => {
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''
  expect(block).toContain('.agent-face__gaze')
  expect(block).toContain('.agent-face__socket')
  expect(block).toContain('.agent-glyph__body')
  expect(block).toMatch(/animation: none !important/)
})

test('the accessible name gains the mood only when asked, and only in the new shell', () => {
  const plain = render(withFaces(<AgentGlyph agent={agent()} mood="needs" />))
  expect(plain.container.firstElementChild?.getAttribute('aria-label')).toBe('builder')
  cleanup()
  const said = render(withFaces(<AgentGlyph agent={agent()} mood="needs" describeMood />))
  expect(said.container.firstElementChild?.getAttribute('aria-label')).toBe('builder, needs you')
  cleanup()
  const idle = render(withFaces(<AgentGlyph agent={agent()} describeMood describeShape />))
  expect(idle.container.firstElementChild?.getAttribute('aria-label')).toBe('builder, triangle')
  cleanup()
  const classic = render(<AgentGlyph agent={agent()} mood="needs" describeMood />)
  expect(classic.container.firstElementChild?.getAttribute('aria-label')).toBe('builder')
})

test('a lively glyph greets on click for about 1.2 s, and follows one shared pointer listener', () => {
  vi.useFakeTimers()
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const { unmount } = render(
    withFaces(
      <>
        <AgentGlyph agent={agent('triangle', 'a')} size="lg" lively />
        <AgentGlyph agent={agent('square', 'b')} size="lg" lively />
      </>,
    ),
  )
  expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
  const glyph = screen.getByRole('img', { name: 'a' })
  expect(glyph.getAttribute('data-greeting')).toBeNull()
  fireEvent.click(glyph)
  expect(glyph.getAttribute('data-greeting')).toBe('')
  expect(glyph.getAttribute('data-face')).toBe('done')
  act(() => {
    vi.advanceTimersByTime(1250)
  })
  expect(glyph.getAttribute('data-greeting')).toBeNull()
  expect(glyph.getAttribute('data-face')).toBe('idle')
  fireEvent.keyDown(glyph, { key: 'Enter' })
  expect(glyph.getAttribute('data-face')).toBe('done')
  unmount()
  expect(remove.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
  add.mockRestore()
  remove.mockRestore()
})

test('a glyph that is not lively ignores clicks and adds no tab stop', () => {
  const { container } = render(withFaces(<AgentGlyph agent={agent()} size="lg" />))
  fireEvent.click(screen.getByRole('img'))
  expect(container.firstElementChild?.getAttribute('data-greeting')).toBeNull()
  expect(container.firstElementChild?.getAttribute('tabindex')).toBeNull()
})
