import { expect, test } from 'vitest'
import { ZodError } from 'zod'
import { loadConfig } from '../src/config.ts'
import { formatStartupError } from '../src/startup-error.ts'

test('startup errors include the listen failure reason without opening sockets', () => {
  const reason = 'listen EADDRINUSE: address already in use 127.0.0.1:8740'
  expect(formatStartupError(new Error(reason))).toBe(`Score server could not start: ${reason}`)
})

test('invalid configuration lists every issue path and message', () => {
  let error: unknown
  try {
    loadConfig({ SCORE_PORT: '0', SCORE_MODE: 'unsupported' })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ZodError)
  if (!(error instanceof ZodError)) throw new Error('Expected config validation to fail')
  const output = formatStartupError(error)
  expect(output).toMatch(/^Score server could not start:\n/)
  expect(error.issues).toHaveLength(2)
  for (const issue of error.issues) {
    expect(output).toContain(`${issue.path.join('.')}: ${issue.message}`)
  }
})

test('startup errors preserve non-Error failure reasons', () => {
  expect(formatStartupError('startup failed')).toBe('Score server could not start: startup failed')
})
