import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { hello, setup } from './helpers.ts'

const plugin = fileURLToPath(new URL('../../../../../hermes-plugin/', import.meta.url))
const script = fileURLToPath(
  new URL('../../../../../hermes-plugin/tests/server-approvals-check.py', import.meta.url),
)

test('gateway hook → exact fake queue resolution → applied delivery attributed to you', async () => {
  const server = setup()
  // The Python side stamps events with wall-clock time; keep the server clock on the same timeline.
  server.setNow(Date.now())
  const child = spawn('python3', ['-I', '-B', script, plugin, server.home], {
    timeout: 10_000,
    env: { PATH: process.env.PATH, HERMES_PROFILE: 'builder' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const protocol = z.object({
    url: z.url(),
    authorization: z.string(),
    body: z.record(z.string(), z.unknown()).nullable(),
  })
  let summary: unknown
  try {
    const other = await server.token({
      ...hello,
      profile: 'reviewer',
      incarnation: 'worker-reviewer',
    })
    const pair = await server.app.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: server.app.pairing.createToken() },
    })
    const cookie = pair.headers['set-cookie']!.toString().split(';')[0]!
    for await (const line of createInterface({ input: child.stdout })) {
      const value: unknown = JSON.parse(line)
      const request = protocol.safeParse(value)
      if (!request.success) {
        summary = value
        continue
      }
      const url = new URL(request.data.url)
      const response = await server.app.inject({
        method: request.data.body === null ? 'GET' : 'POST',
        url: url.pathname + url.search,
        headers: { authorization: request.data.authorization },
        ...(request.data.body === null ? {} : { payload: request.data.body }),
      })
      if (url.pathname === '/bridge/v1/events') {
        expect(response.statusCode).toBe(200)
        const row = server.db.sqlite.prepare('SELECT id, request_id FROM approvals').get()!
        expect(row.request_id).toBe('exact-target')
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: `/api/approvals/${String(row.id)}/decision`,
              headers: { cookie, 'x-score-client': 'web' },
              payload: { choice: 'once' },
            })
          ).statusCode,
        ).toBe(202)
        expect(
          (
            await server.app.inject({
              url: '/bridge/v1/decisions?wait=0',
              headers: server.headers(other),
            })
          ).json(),
        ).toEqual({ items: [] })
      }
      child.stdin.write(
        JSON.stringify({
          statusCode: response.statusCode,
          body: response.statusCode === 204 ? {} : response.json(),
        }) + '\n',
      )
    }
    expect(await exit, stderr).toBe(0)
    expect(summary).toEqual({ resolved: ['exact-target'], pending: ['unrelated'] })
    expect(
      server.db.sqlite.prepare('SELECT state, cycle_attempts FROM approval_deliveries').get(),
    ).toEqual({ state: 'applied', cycle_attempts: 1 })
    const approval = (await server.app.inject('/api/approvals?status=all')).json().items[0]
    expect(approval).toMatchObject({ delivery: 'applied', decision: { choice: 'once', by: 'you' } })
  } finally {
    child.kill()
    await server.close()
  }
})
