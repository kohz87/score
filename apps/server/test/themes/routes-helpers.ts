import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import { StreamEventSchema, ThemeDetailSchema, type StreamEvent } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { multipart } from '../media-fixtures.ts'
import { PNG, WOFF2, manifestJson, zipOf } from './helpers.ts'

export let dir: string
export let db: ScoreDb
export let ingest: Ingest
export let port: FakePort
export let app: ReturnType<typeof buildApp>
export let headers: { 'x-score-client': string; cookie: string }
export let events: StreamEvent[]

export function setupThemeRoutes() {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'score-themes-http-'))
    db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    ingest = createIngest(db)
    port = new FakePort(1, { db }, false)
    await port.start(ingest)
    events = []
    ingest.onCommitted((batch) => {
      events.push(...StreamEventSchema.array().parse(JSON.parse(JSON.stringify(batch))))
    })
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
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
    headers = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
  })
  afterEach(async () => {
    await port.stop()
    await app.close()
    await ingest.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE'
export const call = (
  method: Method,
  url: string,
  payload?: unknown,
  extra: Record<string, string> | null = headers,
) =>
  app.inject({
    method,
    url,
    ...(extra ? { headers: extra } : {}),
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
export function upload(zip: Buffer, query = '', extra: Record<string, string> | null = headers) {
  const { body, contentType } = multipart([
    { name: 'file', filename: 'theme.zip', type: 'application/zip', data: zip },
  ])
  return app.inject({
    method: 'POST',
    url: `/api/themes/import${query}`,
    headers: { ...(extra ?? {}), 'content-type': contentType },
    payload: body,
  })
}
export const fullPackage = (id = 'seaside', css = '.a{background:url(asset:img/a.png)}') =>
  zipOf({
    'theme.json': manifestJson({ id, name: id }),
    'style.css': css,
    'assets/img/a.png': PNG,
    'assets/fonts/f.woff2': WOFF2,
  })
export const save = (id: string, etag: string | null, css = '', extra: object = {}) =>
  call('PUT', `/api/themes/${id}`, {
    manifest: { format: 1, id, name: id, ...extra },
    css,
    etag,
  })
/** A theme file URL bound to the theme's current revision (contract § 16, J1). */
export const fileUrl = async (id: string, path: string) =>
  `/api/themes/${id}/${path}?rev=${ThemeDetailSchema.parse((await call('GET', `/api/themes/${id}`)).json()).etag}`
export const reasons = (res: { json(): unknown }) =>
  (
    res.json() as { error: { code: string; details: { reasons: string[] } } }
  ).error.details.reasons.join('\n')

// C4 #2: a custom save can carry files (the Customizer saves a picture or a font without the import-replace route).
export const PNG2 = Buffer.concat([PNG, Buffer.from(' changed')])
export const b64 = (bytes: Buffer) => bytes.toString('base64')
export const saveFiles = (
  id: string,
  etag: string | null,
  files: object,
  css = '',
  extra: object = {},
) =>
  call('PUT', `/api/themes/${id}`, {
    manifest: { format: 1, id, name: id, ...extra },
    css,
    etag,
    ...files,
  })
export const detailOf = async (id: string) =>
  ThemeDetailSchema.parse((await call('GET', `/api/themes/${id}`)).json())
