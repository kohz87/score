import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BotScreenStatus } from '@score/contract'
import { BoldLiveScreen } from '../BoldLiveScreen.tsx'

type Call = { url: string; method: string; body: unknown; headers: Headers; keepalive: boolean }
let calls: Call[]
let status: BotScreenStatus
let unlockedUntil: string | null
let inputStatus: number
let takeOverStatus: number

const running: BotScreenStatus = { state: 'running', width: 1000, height: 500, frameSeq: 1 }
const inControl = (): BotScreenStatus => ({
  ...running,
  control: {
    takeoverId: 'to1',
    since: new Date().toISOString(),
    idleExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  },
})
const json = (value: unknown, code = 200) =>
  new Response(code === 204 ? null : JSON.stringify(value), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  calls = []
  status = running
  unlockedUntil = null
  inputStatus = 204
  takeOverStatus = 200
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({
        url,
        method,
        body,
        headers: new Headers(init.headers),
        keepalive: Boolean(init.keepalive),
      })
      if (url.endsWith('/bot-screen')) return json(status)
      if (url.endsWith('/session/security'))
        return json({
          passwordSet: true,
          origins: [],
          terminal: false,
          terminalUnavailable: null,
          unlockedUntil,
          serverNow: new Date().toISOString(),
        })
      if (url.endsWith('/take-over')) {
        if (takeOverStatus !== 200)
          return json(
            { error: { code: 'conflict', message: 'Someone already holds it.' } },
            takeOverStatus,
          )
        status = inControl()
        return json({
          takeoverId: 'to1',
          since: status.control!.since,
          expiresAt: status.control!.expiresAt,
        })
      }
      if (url.endsWith('/input'))
        return inputStatus === 204
          ? json(null, 204)
          : json({ error: { code: 'conflict', message: 'gone' } }, inputStatus)
      if (url.endsWith('/hand-back')) {
        status = running
        return json(null, 204)
      }
      return json(null, 204)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <BoldLiveScreen agentId="builder" agentName="builder" />
    </QueryClientProvider>,
  )
}
const posts = (leaf: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(leaf))
const inputEvents = () => posts('/input').flatMap((c) => (c.body as { events: unknown[] }).events)

async function takeOver() {
  renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Take over…' }))
  fireEvent.change(await screen.findByLabelText('Security password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
  return screen.findByRole('application', { name: 'builder’s desktop: you have control' })
}

test('watching → confirm → in control → hand back', async () => {
  const box = await takeOver()
  const take = posts('/take-over')[0]!
  expect(take.body).toEqual({ password: 'pw' })
  expect(take.headers.get('Idempotency-Key')).toBeTruthy()
  expect(take.headers.get('X-Score-Client')).toBe('web')
  expect(screen.getByText('You have control')).toBeDefined()
  expect(box.tabIndex).toBe(0)

  fireEvent.click(screen.getByRole('button', { name: 'Hand back to builder' }))
  await waitFor(() => expect(posts('/hand-back')).toHaveLength(1))
  expect(posts('/hand-back')[0]!.body).toEqual({ takeoverId: 'to1' })
  expect(await screen.findByText(/You handed control back at/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Take over…' })).toBeDefined()
})

test('the confirm card is protected and Cancel closes it', async () => {
  renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Take over…' }))
  const form = (await screen.findByText('Take over builder’s desktop?')).closest('form')!
  expect(form.getAttribute('data-protected')).toBe('block')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByText('Take over builder’s desktop?')).toBeNull()
  expect(posts('/take-over')).toHaveLength(0)
})

test('no password is sent when the security section is unlocked', async () => {
  unlockedUntil = new Date(Date.now() + 200_000).toISOString()
  renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Take over…' }))
  await waitFor(() => expect(screen.queryByLabelText('Security password')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
  await screen.findByRole('application')
  expect(posts('/take-over')[0]!.body).toEqual({})
})

test('a busy screen shows the server’s words', async () => {
  takeOverStatus = 409
  renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Take over…' }))
  fireEvent.change(await screen.findByLabelText('Security password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Someone already holds it.')
})

test('keys and clicks go out in a batch; typed text is never logged', async () => {
  const log = vi.spyOn(console, 'log')
  const box = await takeOver()
  fireEvent.keyDown(box, { key: 'a' })
  fireEvent.keyUp(box, { key: 'a' })
  fireEvent.keyDown(box, { key: 'Dead' })
  await waitFor(() => expect(inputEvents().length).toBeGreaterThanOrEqual(2))
  expect(inputEvents()).toEqual([
    { k: 'key', keysym: 0x61, down: true },
    { k: 'key', keysym: 0x61, down: false },
  ])
  expect(posts('/input')[0]!.body).toMatchObject({ takeoverId: 'to1' })
  expect(log).not.toHaveBeenCalled()
})

test('Type text… sends each character as a down and up pair', async () => {
  await takeOver()
  fireEvent.click(screen.getByRole('button', { name: 'Type text…' }))
  fireEvent.change(await screen.findByLabelText(/Text to type/), { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(inputEvents()).toHaveLength(4))
  expect(inputEvents().map((e) => (e as { keysym: number }).keysym)).toEqual([
    0x68, 0x68, 0x69, 0x69,
  ])
})

test('the shortcut menu sends a chord', async () => {
  await takeOver()
  fireEvent.click(screen.getByRole('button', { name: 'Ctrl+Alt+…' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Esc' }))
  await waitFor(() => expect(inputEvents()).toHaveLength(2))
})

test('a 409 on input ends control and sends nothing more', async () => {
  const box = await takeOver()
  inputStatus = 409
  fireEvent.keyDown(box, { key: 'a' })
  await waitFor(() => expect(posts('/input')).toHaveLength(1))
  status = running
  expect(await screen.findByText(/Control went back to builder/)).toBeDefined()
  const sent = posts('/input').length
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(posts('/input')).toHaveLength(sent)
})

test('heartbeat every 10 seconds while in control', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  await takeOver()
  expect(posts('/heartbeat')).toHaveLength(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_100)
  })
  expect(posts('/heartbeat')).toHaveLength(1)
  expect(posts('/heartbeat')[0]!.body).toEqual({ takeoverId: 'to1' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(posts('/heartbeat')).toHaveLength(2)
})

test('control is handed back when the component unmounts and when the page hides', async () => {
  const { unmount } = renderCard()
  fireEvent.click(await screen.findByRole('button', { name: 'Take over…' }))
  fireEvent.change(await screen.findByLabelText('Security password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Take over' }))
  await screen.findByRole('application')
  unmount()
  const back = posts('/hand-back')
  expect(back).toHaveLength(1)
  expect(back[0]!.keepalive).toBe(true)
  expect(back[0]!.headers.get('X-Score-Client')).toBe('web')
})

test('hiding the page hands control back with keepalive', async () => {
  await takeOver()
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  await waitFor(() => expect(posts('/hand-back')).toHaveLength(1))
  expect(posts('/hand-back')[0]!.keepalive).toBe(true)
})

test('the idle countdown starts near 5:00', async () => {
  await takeOver()
  expect(screen.getByText(/^[45]:[0-5]\d$/)).toBeDefined()
})

test('someone else: the screen is hidden behind a protected line', async () => {
  status = { state: 'human' }
  renderCard()
  const heading = await screen.findByText('Someone else took over in the Hermes app')
  expect(heading.parentElement!.getAttribute('data-protected')).toBe('block')
  expect(screen.queryByRole('img')).toBeNull()
})

const syms = () =>
  inputEvents().map((e) => {
    const k = e as { keysym: number; down: boolean }
    return `${k.keysym.toString(16)}${k.down ? 'v' : '^'}`
  })

test('a key up releases the keysym its down sent, even when Shift changed `key`', async () => {
  const box = await takeOver()
  fireEvent.keyDown(box, { key: 'a', code: 'KeyA' })
  fireEvent.keyDown(box, { key: 'Shift', code: 'ShiftLeft' })
  fireEvent.keyUp(box, { key: 'A', code: 'KeyA' })
  fireEvent.keyUp(box, { key: 'Shift', code: 'ShiftLeft' })
  await waitFor(() => expect(inputEvents()).toHaveLength(4))
  expect(syms()).toEqual(['61v', 'ffe1v', '61^', 'ffe1^'])
})

test('modifier auto-repeat is ignored; a repeating letter is sent', async () => {
  const box = await takeOver()
  fireEvent.keyDown(box, { key: 'Shift', code: 'ShiftLeft' })
  fireEvent.keyDown(box, { key: 'Shift', code: 'ShiftLeft', repeat: true })
  fireEvent.keyDown(box, { key: 'a', code: 'KeyA' })
  fireEvent.keyDown(box, { key: 'a', code: 'KeyA', repeat: true })
  await waitFor(() => expect(inputEvents()).toHaveLength(3))
  expect(syms()).toEqual(['ffe1v', '61v', '61v'])
})

test('blur and Hand back release every held key', async () => {
  const box = await takeOver()
  fireEvent.keyDown(box, { key: 'Control', code: 'ControlLeft' })
  fireEvent.blur(box)
  await waitFor(() => expect(inputEvents()).toHaveLength(2))
  expect(syms()).toEqual(['ffe3v', 'ffe3^'])
  fireEvent.keyDown(box, { key: 'Alt', code: 'AltLeft' })
  fireEvent.click(screen.getByRole('button', { name: 'Hand back to builder' }))
  await waitFor(() => expect(posts('/hand-back')).toHaveLength(1))
  expect(syms().slice(2)).toEqual(['ffe9v', 'ffe9^'])
  const lastInput = calls
    .map((c, i) => (c.url.endsWith('/input') ? i : -1))
    .reduce((a, b) => Math.max(a, b))
  expect(lastInput).toBeLessThan(calls.findIndex((c) => c.url.endsWith('/hand-back')))
})

test('composition is sent once, at its end', async () => {
  await takeOver()
  const field = screen.getByLabelText('Keyboard input for the screen')
  fireEvent.input(field, { inputType: 'insertCompositionText', data: 'x' })
  fireEvent.input(field, { inputType: 'insertCompositionText', data: 'xy' })
  fireEvent.compositionEnd(field, { data: 'xy' })
  await waitFor(() => expect(inputEvents()).toHaveLength(4))
  expect(syms()).toEqual(['78v', '78^', '79v', '79^'])
})

test('Safari’s order (composition end, then the same text as input) still sends it once', async () => {
  await takeOver()
  const field = screen.getByLabelText('Keyboard input for the screen')
  fireEvent.compositionEnd(field, { data: 'xy' })
  fireEvent.input(field, { inputType: 'insertText', data: 'xy' })
  fireEvent.input(field, { inputType: 'insertText', data: 'z' })
  await waitFor(() => expect(inputEvents()).toHaveLength(6))
  expect(syms()).toEqual(['78v', '78^', '79v', '79^', '7av', '7a^'])
})

test('hiding the page shows control as lost', async () => {
  await takeOver()
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  expect(await screen.findByText(/Control went back to builder/)).toBeDefined()
  expect(screen.queryByRole('application')).toBeNull()
})
