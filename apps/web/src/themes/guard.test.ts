import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { contrastVerdict, watchProtectedSurfaces } from './guard.ts'

describe('contrastVerdict', () => {
  test('AA is the bar: 4.5:1 for text, 3:1 for large text and icons', () => {
    expect(contrastVerdict(4.5, 12, false)).toBeNull()
    expect(contrastVerdict(3.9, 12, false)).toBe('has unreadable text')
    expect(contrastVerdict(3.0, 12, true)).toBeNull()
    expect(contrastVerdict(2.9, 12, true)).toBe('has unreadable text')
  })

  test('the old 3:1 floor no longer passes ordinary text', () => {
    expect(contrastVerdict(3.1, 7, false)).toBe('has unreadable text')
  })

  test('below AA is only the theme’s doing when Score’s own look reads better', () => {
    expect(contrastVerdict(3.0, 3.0, false)).toBeNull()
    expect(contrastVerdict(3.0, 3.04, false)).toBeNull()
    expect(contrastVerdict(2.5, 3.0, false)).toBe('has unreadable text')
  })

  test('a colour that can’t be measured fails closed once Score’s own could be', () => {
    expect(contrastVerdict(null, 7, false)).toBe('has text whose colours can’t be checked')
    expect(contrastVerdict(null, null, false)).toBeNull()
    expect(contrastVerdict(3.9, null, false)).toBe('has unreadable text')
  })
})

describe('watchProtectedSurfaces (gate #6)', () => {
  const events = [
    'pointerover',
    'pointerdown',
    'pointerup',
    'focusin',
    'focusout',
    'animationend',
    'transitionend',
  ]

  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.setAttribute('data-look', 'custom')
    document.body.innerHTML = '<div data-protected><button id="go">Approve</button></div>'
  })
  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.removeAttribute('data-look')
    document.body.innerHTML = ''
  })

  test('every event that restyles without touching the DOM schedules a check', () => {
    let calls = 0
    const stop = watchProtectedSurfaces(() => undefined, {
      check: () => {
        calls++
        return null
      },
    })
    vi.advanceTimersByTime(500)
    for (const name of events) {
      const before = calls
      document.getElementById('go')!.dispatchEvent(new Event(name, { bubbles: true }))
      vi.advanceTimersByTime(500)
      expect(calls, name).toBeGreaterThan(before)
    }
    stop()
  })

  test('a violation found after a hover is reported once', () => {
    let answer: string | null = null
    const seen: string[] = []
    const stop = watchProtectedSurfaces((what) => seen.push(what), { check: () => answer })
    vi.advanceTimersByTime(500)
    answer = 'the card is faded'
    document.getElementById('go')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(500)
    document.getElementById('go')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['the card is faded'])
    stop()
  })

  test('a click on a hidden decision is stopped before the app sees it', () => {
    const reached = vi.fn()
    document.getElementById('go')!.addEventListener('click', reached)
    const seen: [string, boolean | undefined][] = []
    const stop = watchProtectedSurfaces((what, refused) => seen.push([what, refused]), {
      check: () => null,
      decision: () => 'the approval is faded',
    })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.getElementById('go')!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(reached).not.toHaveBeenCalled()
    expect(seen).toEqual([['the approval is faded', true]])
    stop()
  })

  test('a submit is vetted too, and a clean decision goes through', () => {
    document.body.innerHTML = '<form data-protected><button>Allow</button></form>'
    const form = document.querySelector('form')!
    const reached = vi.fn((event: Event) => event.preventDefault())
    form.addEventListener('submit', reached)
    let problem: string | null = 'is covered'
    const seen: string[] = []
    const stop = watchProtectedSurfaces((what) => seen.push(what), {
      check: () => null,
      decision: () => problem,
    })
    const refused = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(refused)
    expect(reached).not.toHaveBeenCalled()
    stop()

    problem = null
    const stop2 = watchProtectedSurfaces((what) => seen.push(what), {
      check: () => null,
      decision: () => problem,
    })
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(reached).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['is covered'])
    stop2()
  })
})
