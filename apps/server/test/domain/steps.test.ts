import { expect, test } from 'vitest'
import { parseSteps, writeSteps } from '../../src/domain/steps.ts'

test.each([
  '',
  'No checklist\n\nKeep **all** formatting.\n',
  'Opening\n- [ ] first\n- [x] second\n\nClosing\n',
  'Opening\r\n * [X] first  \r\n   - [ ] second\r\nClosing\r\n',
  '- [ ] no trailing newline',
  '- [ ] first\n\nText\n- [x] a separate list\n',
  '    - [ ] nested content\n\t- [ ] tab content\n',
  '- [ ] first\r- [x] second\rEnd',
])('round-trips every byte of %j', (body) => {
  expect(writeSteps(body, parseSteps(body))).toBe(body)
})

test('IDs distinguish duplicate text and stay stable when checked', () => {
  const body = '- [ ] duplicate\n- [x] duplicate'
  const steps = parseSteps(body)
  expect(steps).toHaveLength(2)
  expect(steps[0]!.id).not.toBe(steps[1]!.id)
  const checked = writeSteps(
    body,
    steps.map((step) => ({ ...step, done: true })),
  )
  expect(checked).toBe('- [x] duplicate\n- [x] duplicate')
  expect(parseSteps(checked).map((step) => step.id)).toEqual(steps.map((step) => step.id))
})

test('replaces, grows and removes just the first checklist', () => {
  const body = 'Start\r\n * [ ] old\r\n\r\nKeep\r\n- [ ] unrelated\r\n'
  expect(
    writeSteps(body, [
      { id: '1', text: 'new', done: true },
      { id: '2', text: 'next', done: false },
    ]),
  ).toBe('Start\r\n * [x] new\r\n- [ ] next\r\n\r\nKeep\r\n- [ ] unrelated\r\n')
  expect(writeSteps(body, [])).toBe('Start\r\n\r\nKeep\r\n- [ ] unrelated\r\n')
})

test('appends a new checklist while preserving the existing prefix', () => {
  const steps = [{ id: '1', text: 'new', done: false }]
  expect(writeSteps('Opening', steps)).toBe('Opening\n- [ ] new')
  expect(writeSteps('Opening\r\n', steps)).toBe('Opening\r\n- [ ] new')
  expect(() => writeSteps('', [{ id: '1', text: 'two\nlines', done: false }])).toThrow(
    'single line',
  )
})
