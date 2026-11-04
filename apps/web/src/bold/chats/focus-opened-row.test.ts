// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusOpenedRowSoon, rememberOpenedRow } from './FilesResults.tsx'

describe('focusOpenedRowSoon', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 16),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    rememberOpenedRow(null)
  })

  it('uses the fallback at once when no row opened the sheet', () => {
    const fallback = vi.fn()
    rememberOpenedRow(null)
    focusOpenedRowSoon(fallback)
    vi.advanceTimersByTime(16)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('keeps trying while the row cannot take focus yet, then focuses it', () => {
    document.body.innerHTML = '<main><a href="#" data-files-row="code:a.py">a</a></main>'
    const row = document.querySelector<HTMLElement>('[data-files-row]')!
    const main = document.querySelector('main')!
    main.setAttribute('inert', '') // the sheet's siblings are inert; jsdom ignores it, so block focus by hand
    const realFocus = row.focus.bind(row)
    row.focus = () => {
      if (main.hasAttribute('inert')) return
      realFocus()
    }
    rememberOpenedRow('code:a.py')
    const fallback = vi.fn()
    focusOpenedRowSoon(fallback)
    vi.advanceTimersByTime(16 * 5)
    expect(document.activeElement).not.toBe(row)
    main.removeAttribute('inert')
    vi.advanceTimersByTime(16 * 2)
    expect(document.activeElement).toBe(row)
    expect(fallback).not.toHaveBeenCalled()
  })
})
