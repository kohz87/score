import { afterEach, expect, test, vi } from 'vitest'

const decode = vi.fn()
vi.mock('./portrait-decode.ts', () => ({ decodePortrait: (url: string) => decode(url) }))

import { loadPortrait, resetPortraits } from './portrait-cache.ts'

const ready = { url: 'blob:p', crop: { x: 0, y: 0, side: 10 }, width: 20, height: 40 }

afterEach(() => {
  resetPortraits()
  decode.mockReset()
})

test('fifty glyphs of one agent decode the idle file once', async () => {
  decode.mockResolvedValue(ready)
  for (let i = 0; i < 50; i += 1) loadPortrait('lead', 'r1')
  await vi.waitFor(() => expect(loadPortrait('lead', 'r1').status).toBe('ready'))
  expect(decode).toHaveBeenCalledTimes(1)
  expect(decode).toHaveBeenCalledWith('/api/agents/lead/pack/idle?rev=r1')
})

test('a new revision or another agent is decoded again', async () => {
  decode.mockResolvedValue(ready)
  loadPortrait('lead', 'r1')
  loadPortrait('lead', 'r2')
  loadPortrait('builder', 'r1')
  expect(decode).toHaveBeenCalledTimes(3)
})

test('a failed decode is remembered as failed, not retried on every glyph', async () => {
  decode.mockRejectedValue(new Error('bad image'))
  loadPortrait('lead', 'r1')
  await vi.waitFor(() => expect(loadPortrait('lead', 'r1').status).toBe('failed'))
  loadPortrait('lead', 'r1')
  expect(decode).toHaveBeenCalledTimes(1)
})
