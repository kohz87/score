import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ThemeDetailSchema, ThemeListSchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { PNG } from './helpers.ts'
import {
  call,
  db,
  dir,
  fileUrl,
  fullPackage,
  ingest,
  port,
  setupThemeRoutes,
  upload,
} from './routes-helpers.ts'

setupThemeRoutes()

// Re-gate finding 2: while a swap note can't be settled, the id is not written (replace, custom save, delete).
test('an id with an unsettled swap note answers 409 theme_recovering until it is settled', async () => {
  await upload(await fullPackage())
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  // Erasing the note fails, so recovery keeps it, as it would after a failed move back.
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  const replaced = await upload(await fullPackage('seaside', '.b{color:red}'), '?replace=1')
  expect(replaced.statusCode).toBe(409)
  expect(replaced.json()).toMatchObject({ error: { code: 'theme_recovering' } })
  expect((await call('DELETE', '/api/themes/seaside')).json()).toMatchObject({
    error: { code: 'theme_recovering' },
  })
  db.sqlite.exec('DROP TRIGGER keep_notes')
  expect(
    (await upload(await fullPackage('seaside', '.b{color:red}'), '?replace=1')).statusCode,
  ).toBe(201)
})

// Third gate finding 4: package reads of an id with an unsettled note are refused, never mixed.
test('detail, assets and export answer 409 theme_recovering while a note is unsettled', async () => {
  await upload(await fullPackage())
  const asset = await fileUrl('seaside', 'assets/img/a.png')
  expect((await call('GET', asset)).statusCode).toBe(200)
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  for (const path of ['/api/themes/seaside', asset, '/api/themes/seaside/export']) {
    const res = await call('GET', path)
    expect([path, res.statusCode]).toEqual([path, 409])
    expect(res.json()).toMatchObject({ error: { code: 'theme_recovering' } })
  }
  // Other themes and the list keep working.
  expect((await call('GET', '/api/themes/harbour')).statusCode).toBe(200)
  expect((await call('GET', '/api/themes')).statusCode).toBe(200)
  db.sqlite.exec('DROP TRIGGER keep_notes')
  expect((await call('GET', '/api/themes/seaside')).statusCode).toBe(200)
  expect((await call('GET', asset)).statusCode).toBe(200)
})

// Third gate finding 4: a start that cannot settle a note still comes up; only that id is refused.
test('a start that keeps a failed note logs it, serves the other themes, and refuses reads of that id', async () => {
  await upload(await fullPackage())
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('dead', 'swap', 'seaside', NULL, 1, 'x')",
    )
    .run()
  db.sqlite.exec(
    "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  )
  const warnings: unknown[] = []
  const second = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: { level: 'warn', stream: { write: (line: string) => warnings.push(JSON.parse(line)) } },
    db,
    ingest,
    port,
  })
  try {
    const pairedAgain = await second.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: second.pairing.createToken() },
    })
    const cookie = pairedAgain.headers['set-cookie']!.toString().split(';')[0]!
    const get = (url: string) =>
      second.inject({ method: 'GET', url, headers: { 'x-score-client': 'web', cookie } })
    expect((await get('/api/themes/harbour')).statusCode).toBe(200)
    expect((await get('/api/themes/seaside')).statusCode).toBe(409)
    expect(JSON.stringify(warnings)).toContain('seaside')
  } finally {
    await second.close()
  }
})

test('start-up undoes a swap that stopped before its row was committed', async () => {
  await upload(await fullPackage())
  // A stop after the old folder went aside and the new one was moved in, before the row was written.
  db.sqlite
    .prepare(
      "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('t1', 'swap', 'seaside', NULL, 1, 'now')",
    )
    .run()
  renameSync(join(dir, 'themes/seaside'), join(dir, 'themes/.old-t1'))
  mkdirSync(join(dir, 'themes/seaside/assets/img'), { recursive: true })
  writeFileSync(join(dir, 'themes/seaside/assets/img/a.png'), 'half-written')
  const second = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
  })
  await second.ready()
  expect(readFileSync(join(dir, 'themes/seaside/assets/img/a.png'))).toEqual(PNG)
  expect(readdirSync(join(dir, 'themes')).filter((name) => name.startsWith('.'))).toEqual([])
  await second.close()
})

test('starting Score after an upgrade moves a theme that has a now built-in id, and the look follows it', async () => {
  // As an earlier Score left it: a theme called "ledger" with assets, active for every device.
  const first = await upload(await fullPackage('seaside'))
  expect(first.statusCode).toBe(201)
  const folder = join(dir, 'themes')
  const row = db.sqlite.prepare('SELECT manifest_json FROM themes WHERE id = ?').get('seaside') as {
    manifest_json: string
  }
  db.sqlite
    .prepare("UPDATE themes SET id = 'ledger', manifest_json = ? WHERE id = 'seaside'")
    .run(JSON.stringify({ ...JSON.parse(row.manifest_json), id: 'ledger' }))
  renameSync(join(folder, 'seaside'), join(folder, 'ledger'))
  db.sqlite.prepare("UPDATE meta SET value = 'ledger' WHERE key = 'look.activeTheme'").run()

  // A fresh start of the app on that data.
  const restarted = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    db,
    ingest,
    port,
  })
  try {
    const paired = await restarted.inject({
      method: 'POST',
      url: '/api/session/pair',
      headers: { 'x-score-client': 'web' },
      payload: { token: restarted.pairing.createToken() },
    })
    const h = {
      'x-score-client': 'web',
      cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    }
    const get = (url: string) => restarted.inject({ method: 'GET', url, headers: h })
    const list = ThemeListSchema.parse((await get('/api/themes')).json())
    expect(list.active).toBe('ledger-mine')
    expect(list.items.filter((item) => item.id === 'ledger')).toHaveLength(1)
    expect(list.items.find((item) => item.id === 'ledger')!.source).toBe('builtin')
    expect(list.items.find((item) => item.id === 'ledger-mine')).toMatchObject({
      source: 'imported',
      name: 'seaside (yours)',
    })
    const mine = ThemeDetailSchema.parse((await get('/api/themes/ledger-mine')).json())
    expect(mine.assets).toEqual(['fonts/f.woff2', 'img/a.png'])
    expect(mine.manifest.id).toBe('ledger-mine')
    expect(
      (await get(`/api/themes/ledger-mine/assets/img/a.png?rev=${mine.etag}`)).statusCode,
    ).toBe(200)
    const builtin = ThemeDetailSchema.parse((await get('/api/themes/ledger')).json())
    expect(builtin.summary.source).toBe('builtin')
    // It can be edited and deleted again (the look moves off it first).
    const put = await restarted.inject({
      method: 'PUT',
      url: '/api/look',
      headers: h,
      payload: { activeTheme: 'score', mode: 'system' },
    })
    expect(put.statusCode).toBe(204)
    const del = await restarted.inject({
      method: 'DELETE',
      url: '/api/themes/ledger-mine',
      headers: h,
    })
    expect(del.statusCode).toBe(204)
  } finally {
    await restarted.close()
  }
})

test('a folder left on disk for an id with no row is not served or exported (K2 X14)', async () => {
  mkdirSync(join(dir, 'themes/ghost/assets/img'), { recursive: true })
  writeFileSync(join(dir, 'themes/ghost/assets/img/a.png'), PNG)
  for (const url of [
    '/api/themes/ghost/assets/img/a.png',
    '/api/themes/ghost/export',
    '/api/themes/ghost',
  ])
    expect((await call('GET', url)).statusCode, url).toBe(404)
})
