import { expect, test } from '@playwright/test'
import { MessageSchema, RoomSchema, StreamEventSchema } from '../packages/contract/src/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../apps/server/src/config.ts'
import { startServer } from '../apps/server/src/start-server.ts'

test('a room turn streams text into the messages API and completes', async ({ playwright }) => {
  // Own the pairing token and data directory; parallel specs cannot share this conversation.
  const home = mkdtempSync(join(tmpdir(), 'score-chat-streaming-'))
  let origin = ''
  const server = await startServer(
    loadConfig({ SCORE_HOME: home, SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }),
    {
      logger: false,
      listen: async (app) => {
        origin = await app.listen({ host: '127.0.0.1', port: 0 })
      },
    },
  )
  const api = await playwright.request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { 'x-score-client': 'web' },
  })
  const abort = new AbortController()
  const frames: ReturnType<typeof StreamEventSchema.parse>[] = []
  let reader: Promise<void> | undefined
  try {
    expect(
      (await api.post('/api/session/pair', { data: { token: server.pairingToken } })).status(),
    ).toBe(204)
    const room = RoomSchema.parse(
      await (
        await api.post('/api/rooms', { data: { name: 'streaming', leadAgentId: 'lead' } })
      ).json(),
    )
    const stream = await fetch(`${origin}/api/stream`, { signal: abort.signal })
    expect(stream.ok).toBe(true)
    const body = stream.body!.getReader()
    reader = (async () => {
      let buffer = ''
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await body.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = frame.split('\n').find((line) => line.startsWith('data: '))
          if (!data) continue
          const parsed = StreamEventSchema.safeParse(JSON.parse(data.slice(6)))
          if (parsed.success) frames.push(parsed.data)
        }
      }
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) throw error
    })
    const response = await api.post(`/api/rooms/${room.id}/messages`, {
      data: { text: 'Check the room context' },
      headers: { 'idempotency-key': 'streaming-turn' },
    })
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ routedTo: ['lead'] })
    const replies = async () =>
      MessageSchema.array()
        .parse((await (await api.get(`/api/rooms/${room.id}/messages`)).json()).items)
        .filter((message) => message.author.kind === 'agent')
    await expect
      .poll(
        async () =>
          (await replies()).some(
            (message) =>
              message.streaming &&
              message.parts.some((part) => part.kind === 'text' && part.text.length > 0),
          ),
        { intervals: [20, 40, 60] },
      )
      .toBe(true)
    const partial = (await replies())[0]!
    const initialText = partial.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('')
    await expect
      .poll(async () => (await replies())[0]?.streaming, { intervals: [20, 40, 60] })
      .toBe(false)
    const completed = (await replies())[0]!
    expect(completed.id).toBe(partial.id)
    const text = completed.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('')
    expect(text.length).toBeGreaterThan(initialText.length)
    // Tool calls arrive as cards (PLAN 5.25); the compact summary is only for older messages.
    expect(completed.parts.filter((part) => part.kind === 'tool')).toHaveLength(5)
    expect(completed.parts.some((part) => part.kind === 'thinking')).toBe(true)
    await expect
      .poll(
        () =>
          frames.filter(
            (event) => event.type === 'message.completed' && event.data.messageId === completed.id,
          ).length,
      )
      .toBe(1)
    expect(
      frames.filter(
        (event) => event.type === 'message.delta' && event.data.messageId === completed.id,
      ).length,
    ).toBeGreaterThan(1)
  } finally {
    abort.abort()
    await reader
    await api.dispose()
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
