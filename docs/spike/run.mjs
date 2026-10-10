// L2 spike: start one run, record its SSE events, answer any approval with "deny",
// and sample state.db mid-run (read-only) to see whether tool calls land before the run ends.
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'

const base = process.argv[2] ?? 'http://127.0.0.1:8642'
const input = process.argv[3]
const out = process.argv[4]
const key = readFileSync(
  `${homedir()}/.score/hermes-keys/${process.env.PROFILE ?? 'default'}`,
  'utf8',
).trim()
const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
const t0 = Date.now()
const log = []
const rec = (kind, data) => log.push({ t: ((Date.now() - t0) / 1000).toFixed(2), kind, data })

const res = await fetch(`${base}/v1/runs`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ input, ...(process.env.MODEL ? { model: process.env.MODEL } : {}) }),
})
const started = await res.json()
rec('POST /v1/runs', { status: res.status, body: started })
const runId = started.run_id ?? started.id
if (!runId) {
  console.log(JSON.stringify(log, null, 1))
  process.exit(1)
}

// Sample state.db every 1.5 s while the run is live.
const sampler = setInterval(() => {
  try {
    const db = new DatabaseSync(
      process.env.PROFILE && process.env.PROFILE !== 'default'
        ? `${homedir()}/.hermes/profiles/${process.env.PROFILE}/state.db`
        : `${homedir()}/.hermes/state.db`,
      { readOnly: true },
    )
    const rows = db
      .prepare(
        `select m.id, m.role, m.tool_name, substr(coalesce(m.tool_calls,''),1,80) tc
      from messages m order by m.id desc limit 4`,
      )
      .all()
    const s = db
      .prepare(
        `select id, profile_name, source, message_count, tool_call_count, last_activity_description
      from sessions order by started_at desc limit 1`,
      )
      .get()
    rec('state.db sample', { session: s ?? null, latestMessages: rows })
    db.close()
  } catch (e) {
    rec('state.db error', String(e))
  }
}, 1500)

const ev = await fetch(`${base}/v1/runs/${runId}/events`, {
  headers: { Authorization: H.Authorization },
})
const reader = ev.body.getReader()
const dec = new TextDecoder()
let buf = ''
outer: while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i)
    buf = buf.slice(i + 2)
    if (frame.startsWith(':')) {
      rec('comment', frame)
      if (frame.includes('stream closed')) break outer
      continue
    }
    const id = frame.match(/^id: (.*)$/m)?.[1]
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('\n')
    let obj
    try {
      obj = JSON.parse(data)
    } catch {
      obj = data
    }
    rec(`event ${obj?.event ?? obj?.type ?? '?'}`, {
      id,
      ...(typeof obj === 'object' ? obj : { raw: obj }),
    })
    if ((obj?.event ?? obj?.type) === 'approval.request' && !process.env.NO_ANSWER) {
      const body = { choice: 'deny', ...(obj.request_id ? { request_id: obj.request_id } : {}) }
      const a = await fetch(`${base}/v1/runs/${runId}/approval`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify(body),
      })
      rec('POST approval deny', { status: a.status, body: await a.json() })
    }
  }
}
clearInterval(sampler)
const st = await fetch(`${base}/v1/runs/${runId}`, { headers: H })
rec('GET /v1/runs/{id}', { status: st.status, body: await st.json() })
writeFileSync(out, JSON.stringify(log, null, 1))
console.log(`wrote ${log.length} records to ${out}`)
