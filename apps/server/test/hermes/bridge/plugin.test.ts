import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { setup } from './helpers.ts'

const script = fileURLToPath(new URL('../../fixtures/bridge/client-check.py', import.meta.url))
const plugin = fileURLToPath(new URL('../../../../../hermes-plugin/', import.meta.url))
const pythonEnv = { PATH: process.env.PATH, HERMES_PROFILE: 'builder' }

test('Python client and sender drain their real payloads through Fastify inject', async () => {
  const server = setup()
  const child = spawn(
    'python3',
    ['-I', '-B', script, plugin, 'http://127.0.0.1', server.home, 'inject'],
    {
      timeout: 10_000,
      env: pythonEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  const protocol = z.object({
    url: z.url(),
    authorization: z.string(),
    body: z.record(z.string(), z.unknown()),
  })
  let summary: unknown
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const value: unknown = JSON.parse(line)
      const request = protocol.safeParse(value)
      if (!request.success) {
        summary = value
        continue
      }
      const response = await server.app.inject({
        method: 'POST',
        url: new URL(request.data.url).pathname,
        headers: { authorization: request.data.authorization },
        payload: request.data.body,
      })
      child.stdin.write(
        JSON.stringify({ statusCode: response.statusCode, body: response.json() }) + '\n',
      )
    }
    expect(await exit).toBe(0)
    expect(summary).toEqual({ ackedThrough: 4, dropped: 1 })
    expect(server.db.sqlite.prepare('SELECT acked_through FROM producers').get()).toEqual({
      acked_through: 4,
    })
    expect(
      server.db.sqlite.prepare('SELECT status, duration_ms FROM session_tool_calls').get(),
    ).toEqual({ status: 'ok', duration_ms: 9 })
    expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM gaps').get()).toEqual({ n: 1 })
  } finally {
    child.kill()
    await server.close()
  }
})

test('Python client and sender handshake and drain a spool through a real loopback server', async (context) => {
  const server = setup()
  try {
    let url: string
    try {
      url = await server.app.listen({ host: '127.0.0.1', port: 0 })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
        context.skip('Sandbox forbids loopback sockets; run this lead check outside the sandbox')
        return
      }
      throw error
    }
    const result = await promisify(execFile)(
      'python3',
      ['-I', '-B', script, plugin, url, server.home],
      {
        timeout: 10_000,
        env: pythonEnv,
      },
    )
    expect(JSON.parse(result.stdout)).toEqual({ ackedThrough: 4, dropped: 1 })
    expect(server.db.sqlite.prepare('SELECT acked_through FROM producers').get()).toEqual({
      acked_through: 4,
    })
    expect(
      server.db.sqlite.prepare('SELECT status, duration_ms FROM session_tool_calls').get(),
    ).toEqual({ status: 'ok', duration_ms: 9 })
    expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM gaps').get()).toEqual({ n: 1 })
  } finally {
    await server.close()
  }
})
