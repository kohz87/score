import { afterEach, expect, test, vi } from 'vitest'
import { copyText } from './clipboard.ts'

afterEach(() => vi.unstubAllGlobals())

test('copyText uses the async clipboard when the page is a secure context', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  expect(await copyText('hermes auth add deepseek')).toBe(true)
  expect(writeText).toHaveBeenCalledWith('hermes auth add deepseek')
})

test('without navigator.clipboard (plain HTTP) it falls back to a selected textarea and execCommand', async () => {
  vi.stubGlobal('navigator', {})
  const exec = vi.fn(() => true)
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
  expect(await copyText('hermes auth add deepseek')).toBe(true)
  expect(exec).toHaveBeenCalledWith('copy')
  expect(document.querySelector('textarea')).toBeNull()
})

test('reports failure when no copy path works, so the UI can select the text instead', async () => {
  vi.stubGlobal('navigator', {})
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true })
  expect(await copyText('x')).toBe(false)
})
