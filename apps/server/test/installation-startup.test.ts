import { DatabaseSync } from 'node:sqlite'
import { GlobalFenceSchema } from '@score/contract'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { resetDatabaseHistory, resetJournalHistory } from '../src/history-reset.ts'
import { confirmCopy, confirmMove } from '../src/installation.ts'
import { startServer } from '../src/start-server.ts'

// 7.7a design v7 §2 at the real boundary: a started server, its journal namespace, and a copied home.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-inst-start-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const configFor = (home: string) =>
  loadConfig({
    SCORE_HOME: home,
    SCORE_MODE: 'fake',
    SCORE_FAKE_SPEED: '100',
    SCORE_FAKE_LOOP: 'false',
    SCORE_JOURNAL_DIR: join(root, 'journal'),
  })

async function start(home: string) {
  const server = await startServer(configFor(home), {
    logger: false,
    listen: async (app) => void (await app.ready()),
  })
  const paired = await server.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: server.pairingToken },
  })
  const headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  const fence = async () =>
    GlobalFenceSchema.parse(
      (await server.app.inject({ url: '/api/orchestrations/fence', headers })).json(),
    )
  const lift = async (revision: number) =>
    server.app.inject({
      method: 'POST',
      url: '/api/orchestrations/fence/lift',
      headers,
      payload: { expectedRevision: revision, reviewed: true },
    })
  return { server, fence, lift }
}

test('a copied home starts, but every admission is blocked and the fence cannot be lifted until it is confirmed', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const first = await start(home)
  const id = first.server.installation!.ok ? first.server.installation!.id : ''
  expect(await first.fence()).toMatchObject({ fenced: false })
  await first.server.close()

  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  rmSync(join(copy, 'score.pid'), { force: true })
  const second = await start(copy)
  try {
    expect(second.server.installation).toBeUndefined()
    const fence = await second.fence()
    expect(fence).toMatchObject({ fenced: true, reason: 'installation_unresolved' })
    expect(fence.items[0]!.detail).toMatch(/confirm-move/)
    const lifted = await second.lift(fence.revision)
    expect(lifted.statusCode).toBe(409)
    expect(lifted.json().error.message).toMatch(/confirm-copy/)
  } finally {
    await second.server.close()
  }

  // Confirmed as a copy: its own id; the inherited history is untrusted (a marker fence), and now the person may lift.
  const result = confirmCopy({ journalDir: join(root, 'journal'), home: copy })
  if (!result.ok) throw new Error(result.message)
  expect(result.id).not.toBe(id)
  // The copied database holds a pending coding turn the source started (FY2 #10): the copy must never send it, and
  // nothing retires it behind the person's back either: Score holds all agent work until reset-history (decision 71).
  const copied = new DatabaseSync(join(copy, 'score.db'))
  copied
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('ci-1', 'start_coding_run', 'turn-copied', '{}', 'pending', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')`,
    )
    .run()
  copied.close()
  const third = await start(copy)
  try {
    expect(third.server.installation).toMatchObject({ ok: true, id: result.id })
    const intent = new DatabaseSync(join(copy, 'score.db'), { readOnly: true })
    expect(
      intent.prepare("SELECT state FROM command_intents WHERE id = 'ci-1'").get(),
    ).toMatchObject({ state: 'pending' })
    intent.close()
    const fence = await third.fence()
    expect(fence).toMatchObject({ fenced: true, untrustedHistory: true })
    expect(fence.items.map((item) => item.detail).join('\n')).toMatch(/is a copy of installation/)
    const holding = fence.items.find((item) => item.ref === 'execution-frozen')
    expect(holding?.detail).toMatch(
      /^Score is holding all agent work: .*Run scripts\/score installation reset-history to continue\.$/,
    )
    const lifted = await third.lift(fence.revision)
    expect(lifted.statusCode).toBe(409)
    expect(lifted.json().error.message).toMatch(/reset-history/)
  } finally {
    await third.server.close()
  }
  // reset-history (Score stopped) starts a fresh history: the copy runs, and the intent is retired for good.
  const namespace = join(root, 'journal', result.id)
  resetJournalHistory({
    journalDir: join(root, 'journal'),
    namespaceDir: namespace,
    installationId: result.id,
  })
  const resetDb = new DatabaseSync(join(copy, 'score.db'))
  resetDatabaseHistory(resetDb, new Date().toISOString())
  resetDb.close()
  const fourth = await start(copy)
  try {
    expect(await fourth.fence()).toMatchObject({ fenced: false })
    const intent = new DatabaseSync(join(copy, 'score.db'), { readOnly: true })
    expect(
      intent.prepare("SELECT state FROM command_intents WHERE id = 'ci-1'").get(),
    ).toMatchObject({ state: 'failed' })
    intent.close()
  } finally {
    await fourth.server.close()
  }
  // The source is untouched.
  const again = await start(home)
  try {
    expect(again.server.installation).toMatchObject({ ok: true, id })
    expect(await again.fence()).toMatchObject({ fenced: false })
  } finally {
    await again.server.close()
  }
})

test('a moved home confirmed with confirm-move keeps its installation and journal namespace', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const first = await start(home)
  const installation = first.server.installation!
  if (!installation.ok) throw new Error('not ok')
  await first.server.close()
  const moved = join(root, 'moved')
  cpSync(home, moved, { recursive: true })
  rmSync(home, { recursive: true })
  const blocked = await start(moved)
  expect(blocked.server.installation).toBeUndefined()
  expect(await blocked.fence()).toMatchObject({ fenced: true, reason: 'installation_unresolved' })
  await blocked.server.close()
  expect(confirmMove({ journalDir: join(root, 'journal'), home: moved })).toMatchObject({
    ok: true,
  })
  const second = await start(moved)
  try {
    expect(second.server.installation).toMatchObject({ ok: true, id: installation.id })
    expect(readFileSync(join(moved, 'installation.json'), 'utf8')).toContain(installation.id)
    // The fence the unconfirmed start raised was the confirmation's to decide: it is gone now.
    expect(await second.fence()).toMatchObject({ fenced: false })
  } finally {
    await second.server.close()
  }
})
