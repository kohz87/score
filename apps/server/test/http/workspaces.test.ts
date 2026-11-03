import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { openDatabase, migrate, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-workspaces-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

let app: ReturnType<typeof buildApp>
let port: FakePort
let db: ScoreDb
let ingest: Ingest
let cookie = ''
let dir = ''
let n = 0

beforeEach(async () => {
  dir = path.join(base, String(++n))
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'work'))
  db = openDatabase(path.join(dir, 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  ingest = createIngest(db)
  port = new FakePort(1, { db }, false)
  await port.start(ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'home') }),
    logger: false,
    db,
    ingest,
    port,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await ingest.close()
  db.close()
  port.workspaceDispose()
})

const human = () => ({ 'x-score-client': 'web', cookie })
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: human(), ...(payload ? { payload } : {}) })
const folder = (name: string) => {
  const target = path.join(dir, 'work', name)
  fs.mkdirSync(target, { recursive: true })
  return target
}
const make = async (name: string, p = folder(name)) => {
  const response = await call('POST', '/api/workspaces', { name, path: p })
  expect(response.statusCode, response.body).toBe(201)
  return response.json() as { id: string; path: string; agentIds: string[]; roomIds: string[] }
}

describe('workspaces', () => {
  test('need a paired human', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/workspaces' })
    expect(response.statusCode).toBe(401)
  })

  test('create, list, rename and assign agents (which must exist)', async () => {
    const one = await make('feed')
    expect(one).toMatchObject({ agentIds: [], roomIds: [], path: path.join(dir, 'work', 'feed') })
    expect((await call('GET', '/api/workspaces')).json().workspaces).toHaveLength(1)
    const patched = await call('PATCH', `/api/workspaces/${one.id}`, {
      name: 'activity-feed',
      agentIds: ['builder', 'lead', 'builder'],
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json()).toMatchObject({ name: 'activity-feed', agentIds: ['builder', 'lead'] })
    expect(
      (await call('PATCH', `/api/workspaces/${one.id}`, { agentIds: ['nobody'] })).statusCode,
    ).toBe(400)
    expect((await call('PATCH', '/api/workspaces/missing', { name: 'x' })).statusCode).toBe(404)
    await make('notes')
    expect((await call('PATCH', `/api/workspaces/${one.id}`, { name: 'notes' })).statusCode).toBe(
      409,
    )
    expect(
      (await call('POST', '/api/workspaces', { name: 'again', path: one.path })).statusCode,
    ).toBe(409)
  })

  test('a folder must pass the root policy: system folders, files, missing folders, Score’s home', async () => {
    for (const bad of [
      '/',
      '/etc',
      os.homedir(),
      path.join(dir, 'home'),
      path.join(dir, 'work', 'nope'),
    ]) {
      const response = await call('POST', '/api/workspaces', { name: 'bad', path: bad })
      expect(response.statusCode, bad).toBe(422)
      expect(response.json().error.code).toBe('workspace_unavailable')
    }
    const file = path.join(dir, 'work', 'file.txt')
    fs.writeFileSync(file, 'x')
    expect((await call('POST', '/api/workspaces', { name: 'f', path: file })).statusCode).toBe(422)
    // A symlink into a refused folder resolves first.
    const link = path.join(dir, 'work', 'link')
    fs.symlinkSync(path.join(dir, 'home'), link)
    expect((await call('POST', '/api/workspaces', { name: 'l', path: link })).statusCode).toBe(422)
    expect((await call('GET', '/api/workspaces')).json().workspaces).toEqual([])
  })

  test('create makes a missing folder (0700) only under a parent that passes the policy', async () => {
    const target = path.join(dir, 'work', 'fresh')
    const made = await call('POST', '/api/workspaces', {
      name: 'fresh',
      path: target,
      create: true,
    })
    expect(made.statusCode, made.body).toBe(201)
    expect(fs.statSync(target).mode & 0o777).toBe(0o700)
    // Without the flag a missing folder is refused; with it, a parent that fails the policy is too.
    expect(
      (await call('POST', '/api/workspaces', { name: 'x', path: path.join(dir, 'work', 'a', 'b') }))
        .statusCode,
    ).toBe(422)
    expect(
      (
        await call('POST', '/api/workspaces', {
          name: 'y',
          path: path.join(dir, 'work', 'a', 'b'),
          create: true,
        })
      ).statusCode,
    ).toBe(422)
    expect(fs.existsSync(path.join(dir, 'work', 'a'))).toBe(false)
    const inScore = path.join(dir, 'home', 'inside')
    expect(
      (await call('POST', '/api/workspaces', { name: 'z', path: inScore, create: true }))
        .statusCode,
    ).toBe(422)
    expect(fs.existsSync(inScore)).toBe(false)
  })

  test('a room is set to a workspace and back; delete clears rooms and keeps the folder', async () => {
    const one = await make('feed')
    const room = (await call('POST', '/api/rooms', { name: 'chat', leadAgentId: 'lead' })).json()
    const set = await call('PUT', `/api/rooms/${room.id}/workspace`, { workspaceId: one.id })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json().workspaceId).toBe(one.id)
    expect((await call('GET', '/api/workspaces')).json().workspaces[0].roomIds).toEqual([room.id])
    expect((await call('GET', `/api/rooms/${room.id}`)).json().room.workspaceId).toBe(one.id)
    expect(
      (await call('PUT', `/api/rooms/${room.id}/workspace`, { workspaceId: 'nope' })).statusCode,
    ).toBe(404)
    expect((await call('PUT', '/api/rooms/nope/workspace', { workspaceId: null })).statusCode).toBe(
      404,
    )
    expect((await call('DELETE', `/api/workspaces/${one.id}`)).statusCode).toBe(204)
    expect(fs.existsSync(one.path)).toBe(true)
    expect((await call('GET', `/api/rooms/${room.id}`)).json().room.workspaceId).toBeNull()
    expect(db.sqlite.prepare('SELECT * FROM workspace_agents').all()).toEqual([])
    expect((await call('DELETE', `/api/workspaces/${one.id}`)).statusCode).toBe(404)
  })

  test('use-as-folder: only an assigned Hermes agent, only a local one', async () => {
    const one = await make('feed')
    const other = await make('notes')
    await call('PATCH', `/api/workspaces/${one.id}`, { agentIds: ['builder'] })
    const unassigned = await call('POST', `/api/workspaces/${one.id}/use-as-folder`, {
      agentId: 'lead',
    })
    expect(unassigned.statusCode).toBe(409)
    expect(
      (await call('POST', `/api/workspaces/${other.id}/use-as-folder`, { agentId: 'builder' }))
        .statusCode,
    ).toBe(409)
    const ok = await call('POST', `/api/workspaces/${one.id}/use-as-folder`, { agentId: 'builder' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await port.readWorkspaceConfig('builder')).toMatchObject({ cwd: one.path })
    expect(
      (await call('POST', '/api/workspaces/missing/use-as-folder', { agentId: 'builder' }))
        .statusCode,
    ).toBe(404)
  })
})
