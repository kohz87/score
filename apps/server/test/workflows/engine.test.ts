import { afterEach, expect, test } from 'vitest'
import {
  agent,
  definition,
  edge,
  end,
  node,
  run,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

test('the smallest graph: agent → end succeeds with the graph at its end', async () => {
  h = await wfHarness()
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(() => run(h!, id).status === 'succeeded')
  const detail = run(h, id)
  expect(detail.graphOutcome).toBe('reached_end')
  expect(node(h, id, 'a').state).toBe('succeeded')
  expect(node(h, id, 'done').state).toBe('succeeded')
  expect(detail.tokens.every((t) => t.consumedBy !== null)).toBe(true)
  expect(h.errors).toEqual([])
})
