import { expect, test } from 'vitest'
import { passkeyHostUsable, passkeyOrigin } from './passkeys.ts'

test('passkeys work on a domain name or localhost, never on an IP address', () => {
  expect(passkeyHostUsable('score.example.ts.net')).toBe(true)
  expect(passkeyHostUsable('localhost')).toBe(true)
  expect(passkeyHostUsable('192.168.1.20')).toBe(false)
  expect(passkeyHostUsable('[::1]')).toBe(false)
  expect(passkeyHostUsable('hermesvm')).toBe(false)
})

test('the hint link picks the first configured domain origin', () => {
  expect(passkeyOrigin(['https://192.168.1.20:8741', 'https://vm.tail1.ts.net:8741'])).toBe(
    'https://vm.tail1.ts.net:8741',
  )
  expect(passkeyOrigin(['https://192.168.1.20:8741'])).toBeUndefined()
})
