import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const FixtureSchema = z.array(
  z
    .object({
      event: z.string(),
      run_id: z.string(),
      seq: z.int().nonnegative(),
      timestamp: z.number(),
    })
    .passthrough(),
)
export type FixtureEvent = z.infer<typeof FixtureSchema>[number]
export function fixture(name: 'l2' | 'l4a'): FixtureEvent[] {
  return FixtureSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../fixtures/hermes/${name}-run-events.json`, import.meta.url),
        'utf8',
      ),
    ),
  )
}
const json = (body: unknown, status = 200) => Response.json(body, { status })
interface FakeRun {
  profile: string
  input: string
  id: string
  terminal: boolean
}
export class FakeGateway {
  readonly keys = new Map([
    ['default', 'default-fixture-key'],
    ['builder', 'builder-fixture-key'],
  ])
  readonly runs = new Map<string, FakeRun>()
  readonly admissions = new Map<string, string>()
  readonly calls: { path: string; method: string; cursor: string | null; body: unknown }[] = []
  creations = 0
  streams = 0
  polls = 0
  dropAt: number | undefined
  sse404 = false
  truncate = false
  eof = false
  empty = false
  crashAfterAdmission = false
  terminalAfterPoll = 2
  events: FixtureEvent[] = fixture('l2')
  private identity(profile: string, id: string) {
    return `${profile}:${id}`
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const parts = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/)
    const profile = parts?.[1] ?? 'default'
    const path = parts?.[2] ?? url.pathname
    const headers = new Headers(init?.headers)
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    this.calls.push({ path: url.pathname, method, cursor: headers.get('Last-Event-ID'), body })
    if (path === '/v1/health')
      return json({ status: 'ok', platform: 'hermes-agent', version: '0.21.5' })
    if (!this.keys.has(profile)) return json({ error: 'Unknown or unconfigured profile' }, 404)
    if (headers.get('Authorization') !== `Bearer ${this.keys.get(profile)}`)
      return json({ error: { code: 'gateway_auth_failed', message: 'denied' } }, 401)
    if (path === '/v1/capabilities')
      return json({
        features: {
          run_submission: true,
          run_status: true,
          run_events_sse: true,
          run_stop: true,
          run_steer: true,
          run_approval_response: true,
          session_continuity_header: 'X-Hermes-Session-Id',
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
        },
      })
    if (path === '/v1/runs' && method === 'POST') {
      const key = headers.get('Idempotency-Key')
      if (!key) return json({ error: { code: 'invalid_request' } }, 400)
      const request = z.object({ input: z.string() }).parse(body)
      const scope = this.identity(profile, key)
      const existing = this.admissions.get(scope)
      if (existing) {
        if (this.runs.get(this.identity(profile, existing))?.input !== request.input)
          return json({ error: { code: 'idempotency_conflict' } }, 409)
        return json({ run_id: existing, status: 'running', replayed: true }, 202)
      }
      const id = `run_${profile}_${++this.creations}`
      this.admissions.set(scope, id)
      this.runs.set(this.identity(profile, id), {
        profile,
        input: request.input,
        id,
        terminal: false,
      })
      if (this.crashAfterAdmission) {
        this.crashAfterAdmission = false
        throw new Error(`HTTP admitted, connection failed: ${this.keys.get(profile)}`)
      }
      return json({ run_id: id, status: 'started', replayed: false }, 202)
    }
    const match = path.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval))?$/)
    const run = match && this.runs.get(this.identity(profile, decodeURIComponent(match[1]!)))
    if (!run) return json({ error: { code: 'run_not_found' } }, 404)
    const action = match![2]
    if (action === 'stop') return json({ run_id: run.id, status: 'stopping' })
    if (action === 'steer') return json({ run_id: run.id, accepted: true })
    if (action === 'approval')
      return json({ error: { code: 'approval_not_pending', message: this.keys.get(profile) } }, 409)
    if (action === 'events') {
      this.streams++
      if (this.sse404) return json({ error: 'no stream' }, 404)
      if (this.truncate)
        return new Response('data: {"event":"replay.truncated","oldest_retained_seq":10}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      const cursor = headers.get('Last-Event-ID')
      const filtered = this.events.filter((event) => cursor === null || event.seq >= Number(cursor))
      const dropping = this.dropAt !== undefined && this.streams === 1
      const selected = this.empty ? [] : dropping ? filtered.slice(0, this.dropAt) : filtered
      let text = selected
        .map(
          (event) => `id: ${event.seq}\ndata: ${JSON.stringify({ ...event, run_id: run.id })}\n\n`,
        )
        .join('')
      if (!dropping && !this.empty) {
        run.terminal = true
        if (!this.eof) text += ': stream closed\n\n'
      }
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(new TextEncoder().encode(text))
              return
            }
            if (dropping) controller.error(new Error('dropped'))
            else controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    this.polls++
    const terminal =
      run.terminal ||
      (this.polls >= this.terminalAfterPoll && (this.sse404 || this.truncate || this.empty))
    const last = this.events.at(-1)!
    return json({
      run_id: run.id,
      status: terminal ? 'completed' : 'running',
      created_at: this.events[0]!.timestamp,
      updated_at: last.timestamp,
      session_id: run.id,
      model: 'fixture-model',
      output: terminal ? (last.output ?? 'done') : null,
      error: null,
      last_event: terminal ? 'run.completed' : 'run.started',
      ...(terminal ? { usage: last.usage } : {}),
    })
  }
}
