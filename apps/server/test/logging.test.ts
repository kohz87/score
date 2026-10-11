import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

test('logs redact cookies and authorization and never include pairing tokens', async () => {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  const app = buildApp({ config: loadConfig({}), logger: { level: 'info', stream } })
  try {
    const token = app.pairing.createToken()
    app.get('/test/error', async () => {
      throw new Error(`sensitive: ${token}`)
    })
    app.get('/test/credentials', async (request) => {
      throw new Error(
        `credentials rejected: ${request.headers.cookie}; ${request.headers.authorization}`,
      )
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web', authorization: 'Bearer private-authorization' },
      payload: { token },
    })
    expect(response.statusCode).toBe(204)
    const setCookie = String(response.headers['set-cookie'])
    const cookie = setCookie.split(';', 1)[0]
    if (!cookie) throw new Error('Session cookie missing')
    const sessionId = cookie.slice('score_session='.length)
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
      paired: true,
    })
    const failure = await app.inject(`/test/error?token=${token}`)
    expect(failure.statusCode).toBe(500)
    expect(failure.json()).toEqual({
      error: { code: 'internal', message: 'Something went wrong inside Score. Try again.' },
    })
    const credentialFailure = await app.inject({
      url: '/test/credentials',
      headers: { cookie, authorization: 'Bearer private-authorization' },
    })
    expect(credentialFailure.statusCode).toBe(500)
    expect(credentialFailure.json()).toEqual({
      error: { code: 'internal', message: 'Something went wrong inside Score. Try again.' },
    })
    await app.inject(`/unknown/${token}`)
    await app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token },
    })
    const logs = chunks.join('')
    expect(logs).not.toContain(token)
    expect(logs).not.toContain(cookie)
    expect(logs).not.toContain(setCookie)
    expect(logs).not.toContain(sessionId)
    expect(logs).not.toContain('private-authorization')
    const entries = chunks
      .flatMap((chunk) => chunk.trim().split('\n'))
      .map((line) => JSON.parse(line))
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'Internal server error',
        err: expect.objectContaining({
          type: 'Error',
          message: 'sensitive: [Redacted]',
          stack: expect.stringContaining('test/logging.test.ts:'),
        }),
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        msg: 'Internal server error',
        err: expect.objectContaining({
          message: 'credentials rejected: [Redacted]; [Redacted]',
          stack: expect.stringContaining('test/logging.test.ts:'),
        }),
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        req: expect.objectContaining({
          headers: expect.objectContaining({ authorization: '[Redacted]' }),
        }),
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        req: expect.objectContaining({
          headers: expect.objectContaining({ cookie: '[Redacted]' }),
        }),
      }),
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        res: expect.objectContaining({
          headers: expect.objectContaining({ 'set-cookie': '[Redacted]' }),
        }),
      }),
    )
  } finally {
    await app.close()
    stream.end()
  }
})
