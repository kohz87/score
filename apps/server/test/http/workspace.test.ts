import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { parseGitStatus } from '../../src/workspace/git.ts'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-ws-http-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie = ''
let root = ''
let outside = ''
let n = 0
const W = '/api/agents/builder/workspace'

beforeEach(async () => {
  const dir = path.join(base, String(++n))
  root = path.join(dir, 'project')
  outside = path.join(dir, 'outside')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
  port = new FakePort(1, {}, false)
  await port.setWorkspaceCwd('builder', root)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: path.join(dir, 'score-home') }),
    logger: false,
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
  port.workspaceDispose()
})

const human = () => ({ 'x-score-client': 'web', cookie })
const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = human(),
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const q = (p: string) => encodeURIComponent(p)

describe('guard', () => {
  test('every workspace route needs a paired browser, reads included', async () => {
    const none = { 'x-score-client': 'web' }
    for (const [method, url] of [
      ['GET', W],
      ['GET', `${W}/tree`],
      ['GET', `${W}/file?path=README.md`],
      ['PUT', `${W}/file?path=README.md`],
      ['POST', `${W}/entries`],
      ['POST', `${W}/move`],
      ['DELETE', `${W}/entries?path=x`],
      ['POST', `${W}/upload?path=x`],
      ['PUT', `${W}/root`],
    ] as const) {
      const response = await call(method, url, { path: 'x', content: '', etag: null }, none)
      expect(response.statusCode, `${method} ${url}`).toBe(401)
    }
    expect(fs.readdirSync(root).sort()).toEqual(['.env', 'README.md', 'src'])
  })
})

describe('state and root', () => {
  test('reports the root, a remote backend and an unset folder with the reason', async () => {
    expect((await call('GET', W)).json()).toEqual({ root, available: true, reason: null })
    const remote = (await call('GET', '/api/agents/designer/workspace')).json()
    expect(remote).toMatchObject({ root: null, available: false })
    expect(remote.reason).toMatch(/remote terminal \(docker\)/)
    expect((await call('GET', '/api/agents/designer/workspace/tree')).statusCode).toBe(409)
    expect((await call('GET', '/api/agents/nobody/workspace')).statusCode).toBe(404)
  })
  test('a configured root that fails the checks makes the workspace unavailable', async () => {
    await port.setWorkspaceCwd('builder', os.homedir())
    const state = (await call('GET', W)).json()
    expect(state.available).toBe(false)
    expect(state.reason).toMatch(/home folder/)
    await port.setWorkspaceCwd('builder', '.')
    expect((await call('GET', W)).json().reason).toMatch(/No working folder/)
  })
  test('set folder: refuses dangerous or missing folders, accepts an existing one', async () => {
    for (const bad of [
      '/',
      os.homedir(),
      path.join(os.homedir(), '.hermes'),
      path.join(os.homedir(), '.ssh'),
      path.join(root, 'missing'),
      path.join(root, 'README.md'),
      'relative',
    ]) {
      const response = await call('PUT', `${W}/root`, { path: bad })
      expect(response.statusCode, bad).toBe(409)
      expect(response.json().error.code).toBe('workspace_unavailable')
    }
    expect((await call('GET', W)).json().root).toBe(root)
    const ok = await call('PUT', `${W}/root`, { path: path.join(root, 'src') })
    expect(ok.json()).toEqual({ root: path.join(root, 'src'), available: true, reason: null })
    expect((await call('GET', W)).json().root).toBe(path.join(root, 'src'))
    expect(
      (await call('PUT', '/api/agents/designer/workspace/root', { path: root })).statusCode,
    ).toBe(409)
  })
})

describe('tree and file', () => {
  test('lists one level without blocked names and rejects bad paths', async () => {
    const tree = (await call('GET', `${W}/tree`)).json()
    expect(tree.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md'])
    expect((await call('GET', `${W}/tree?path=${q('../outside')}`)).statusCode).toBe(400)
    expect((await call('GET', `${W}/tree?path=${q('/etc')}`)).statusCode).toBe(400)
    expect((await call('GET', `${W}/tree?path=${q('a\0b')}`)).statusCode).toBe(400)
  })
  test('serves text with an ETag and nosniff, and refuses blocked files', async () => {
    const response = await call('GET', `${W}/file?path=README.md`)
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('# hi\n')
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]{32}"$/)
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const blocked = await call('GET', `${W}/file?path=.env`)
    expect(blocked.statusCode).toBe(403)
    expect(blocked.body).not.toContain('SECRET')
    expect((await call('GET', `${W}/file?path=missing.txt`)).statusCode).toBe(404)
  })
  test('serves images inline and PDFs as attachments under a sandbox CSP, binaries as JSON, downloads as attachments', async () => {
    fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([1, 0, 2]))
    const image = await call('GET', `${W}/file?path=a.png`)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['content-disposition']).toBe('inline')
    expect(image.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect((await call('GET', `${W}/file?path=b.bin`)).json()).toEqual({
      binary: true,
      size: 3,
      reason: 'binary',
    })
    const download = await call('GET', `${W}/file?path=b.bin&download=1`)
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename\*=UTF-8''b\.bin$/,
    )
    expect(download.headers['content-type']).toBe('application/octet-stream')
    // PDFs are never shown inline from Score's origin (the viewer can't run under the sandbox CSP): attachment.
    fs.writeFileSync(path.join(root, 'r.pdf'), Buffer.from('%PDF-1.7\n%%EOF\n'))
    const pdf = await call('GET', `${W}/file?path=r.pdf`)
    expect(pdf.headers['content-type']).toBe('application/octet-stream')
    expect(pdf.headers['content-disposition']).toBe("attachment; filename*=UTF-8''r.pdf")
    expect(pdf.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
  })
  test('refuses a symlink that leaves the workspace', async () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    const response = await call('GET', `${W}/file?path=leak.txt`)
    expect(response.statusCode).toBe(403)
    expect(response.body).not.toContain('outside secret')
  })
})

describe('writes', () => {
  test('create, edit with an etag, conflict (412 with the current etag), overwrite', async () => {
    const created = await call('PUT', `${W}/file?path=notes.md`, { content: 'one', etag: null })
    expect(created.statusCode).toBe(200)
    const { etag } = created.json()
    expect(
      (await call('PUT', `${W}/file?path=notes.md`, { content: 'x', etag: null })).statusCode,
    ).toBe(409)
    fs.writeFileSync(path.join(root, 'notes.md'), 'edited elsewhere')
    const stale = await call('PUT', `${W}/file?path=notes.md`, { content: 'two', etag })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().error.code).toBe('precondition_failed')
    const current = stale.json().error.details.etag
    expect(current).not.toBe(etag)
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('edited elsewhere')
    expect(
      (await call('PUT', `${W}/file?path=notes.md`, { content: 'two', etag: current })).statusCode,
    ).toBe(200)
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('two')
  })
  test('refuses blocked names, traversal and oversized content', async () => {
    expect(
      (await call('PUT', `${W}/file?path=.env.local`, { content: 'x', etag: null })).statusCode,
    ).toBe(403)
    expect(
      (await call('PUT', `${W}/file?path=${q('../escape.txt')}`, { content: 'x', etag: null }))
        .statusCode,
    ).toBe(400)
    expect(
      (
        await call('PUT', `${W}/file?path=big.txt`, {
          content: 'a'.repeat(1024 * 1024 + 1),
          etag: null,
        })
      ).statusCode,
    ).toBe(413)
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.txt'))).toBe(false)
  })
  test('new folder and file, rename, delete (recursive needs the flag)', async () => {
    expect((await call('POST', `${W}/entries`, { path: 'docs', kind: 'dir' })).statusCode).toBe(201)
    expect(
      (await call('POST', `${W}/entries`, { path: 'docs/a.md', kind: 'file' })).statusCode,
    ).toBe(201)
    expect((await call('POST', `${W}/entries`, { path: 'docs', kind: 'dir' })).statusCode).toBe(409)
    expect(
      (await call('POST', `${W}/move`, { from: 'docs/a.md', to: 'docs/b.md' })).statusCode,
    ).toBe(200)
    expect(fs.existsSync(path.join(root, 'docs', 'b.md'))).toBe(true)
    expect(
      (await call('POST', `${W}/move`, { from: 'README.md', to: 'docs/b.md' })).statusCode,
    ).toBe(409)
    expect((await call('DELETE', `${W}/entries?path=docs`)).statusCode).toBe(409)
    expect((await call('DELETE', `${W}/entries?path=docs&recursive=1`)).statusCode).toBe(200)
    expect(fs.existsSync(path.join(root, 'docs'))).toBe(false)
    expect((await call('DELETE', `${W}/entries?path=${q('')}`)).statusCode).toBe(400)
  })
  test('upload takes a raw octet-stream body, refuses overwrite and other content types', async () => {
    const bytes = Buffer.from([0, 1, 2, 250])
    const octet = { ...human(), 'content-type': 'application/octet-stream' }
    const ok = await app.inject({
      method: 'POST',
      url: `${W}/upload?path=src/data.bin`,
      headers: octet,
      payload: bytes,
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toEqual({ path: 'src/data.bin', size: 4 })
    expect(fs.readFileSync(path.join(root, 'src', 'data.bin'))).toEqual(bytes)
    const again = await app.inject({
      method: 'POST',
      url: `${W}/upload?path=src/data.bin`,
      headers: octet,
      payload: bytes,
    })
    expect(again.statusCode).toBe(409)
    const blocked = await app.inject({
      method: 'POST',
      url: `${W}/upload?path=.env.prod`,
      headers: octet,
      payload: bytes,
    })
    expect(blocked.statusCode).toBe(403)
    const json = await call('POST', `${W}/upload?path=x.bin`, { a: 1 })
    expect(json.statusCode).toBe(400)
    const big = await app.inject({
      method: 'POST',
      url: `${W}/upload?path=big.bin`,
      headers: octet,
      payload: Buffer.alloc(25 * 1024 * 1024 + 1),
    })
    expect(big.statusCode).toBe(413)
    expect(fs.existsSync(path.join(root, 'big.bin'))).toBe(false)
  })
})

describe('git badge', () => {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args],
      { stdio: 'pipe' },
    )

  test('is null outside a repository', async () => {
    // The temp tree sits outside any repository, so there is nothing to find in the parents either.
    const res = await call('GET', `${W}/git`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  test('reports the branch and the number of changed files, and never writes to the repository', async () => {
    git('init', '-q', '-b', 'trunk')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'first')
    fs.writeFileSync(path.join(root, 'README.md'), '# changed\n')
    fs.writeFileSync(path.join(root, 'new.txt'), 'x')
    const before = fs.statSync(path.join(root, '.git', 'index')).mtimeMs
    const res = await call('GET', `${W}/git`)
    expect(res.json()).toEqual({ branch: 'trunk', changed: 3, ahead: 0, behind: 0 })
    // README.md modified, new.txt and .env untracked.
    expect(fs.statSync(path.join(root, '.git', 'index')).mtimeMs).toBe(before)
  })

  test('needs a paired browser', async () => {
    const res = await call('GET', `${W}/git`, undefined, { 'x-score-client': 'web' })
    expect(res.statusCode).toBe(401)
  })
})

describe('parseGitStatus', () => {
  test('reads branch, upstream counts, a fresh repository and a detached head', () => {
    expect(parseGitStatus('## main...origin/main [ahead 2, behind 1]\n M a\n?? b\n')).toEqual({
      branch: 'main',
      changed: 2,
      ahead: 2,
      behind: 1,
    })
    expect(parseGitStatus('## No commits yet on dev\n')).toMatchObject({
      branch: 'dev',
      changed: 0,
    })
    expect(parseGitStatus('## HEAD (no branch)\n')).toMatchObject({ branch: 'detached HEAD' })
    expect(parseGitStatus('')).toBeNull()
  })
})

describe('git badge safety', () => {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args],
      { stdio: 'pipe' },
    )

  test('a repository that configures a clean filter is not run and nothing executes', async () => {
    const marker = path.join(root, '..', `filter-ran-${path.basename(root)}`)
    const script = path.join(root, '..', `filter-${path.basename(root)}.sh`)
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 })
    git('init', '-q', '-b', 'trunk')
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt filter=probe\n')
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n')
    git('add', '.gitattributes', 'tracked.txt')
    git('commit', '-q', '-m', 'first')
    git('config', 'filter.probe.clean', script)
    fs.rmSync(marker, { force: true })
    // Same size, new mtime: git must re-read the file to decide, which runs the clean filter.
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n')
    const res = await call('GET', `${W}/git`)
    expect(res.json()).toBeNull()
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(script, { force: true })
  })

  test('counts untracked files one by one, not as one folder', async () => {
    git('init', '-q', '-b', 'trunk')
    fs.mkdirSync(path.join(root, 'many'))
    for (const n of [1, 2, 3, 4]) fs.writeFileSync(path.join(root, 'many', `f${n}.txt`), 'x')
    const res = await call('GET', `${W}/git`)
    // README.md and .env from the fixture plus four files in the new folder.
    expect(res.json()).toMatchObject({ changed: 6 })
  })
})

describe('root identity', () => {
  test('a request that names a root which is no longer the agent root is refused and touches nothing', async () => {
    const other = path.join(path.dirname(root), 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'report.txt'), 'B')
    fs.writeFileSync(path.join(root, 'report.txt'), 'A')
    const shown = root
    await port.setWorkspaceCwd('builder', other)
    const removed = await call('DELETE', `${W}/entries?path=report.txt&root=${q(shown)}`)
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('workspace_changed')
    expect(fs.existsSync(path.join(other, 'report.txt'))).toBe(true)
    for (const [method, url, payload] of [
      ['GET', `${W}/tree?root=${q(shown)}`, undefined],
      ['GET', `${W}/file?path=report.txt&root=${q(shown)}`, undefined],
      ['PUT', `${W}/file?path=report.txt&root=${q(shown)}`, { content: 'x', etag: null }],
      ['POST', `${W}/entries?root=${q(shown)}`, { path: 'n.txt', kind: 'file' }],
      ['POST', `${W}/move?root=${q(shown)}`, { from: 'report.txt', to: 'r2.txt' }],
      ['GET', `${W}/git?root=${q(shown)}`, undefined],
    ] as const) {
      const res = await call(method, url, payload)
      expect(res.statusCode, `${method} ${url}`).toBe(409)
    }
    expect(fs.readdirSync(other)).toEqual(['report.txt'])
    const ok = await call('GET', `${W}/tree?root=${q(other)}`)
    expect(ok.statusCode).toBe(200)
  })
})

describe('default Hermes home stays protected with a custom one', () => {
  test('~/.hermes cannot become the workspace when SCORE_HERMES_HOME points elsewhere', async () => {
    const fakeHome = path.join(path.dirname(root), 'fakehome')
    fs.mkdirSync(path.join(fakeHome, '.hermes'), { recursive: true })
    const savedHome = process.env.HOME
    process.env.HOME = fakeHome
    const custom = buildApp({
      config: loadConfig({
        SCORE_MODE: 'fake',
        SCORE_HOME: path.join(fakeHome, 'sh'),
        SCORE_HERMES_HOME: path.join(fakeHome, 'elsewhere'),
      }),
      logger: false,
      port,
    })
    try {
      const paired = await custom.inject({
        method: 'POST',
        url: '/api/session/pair',
        headers: { 'x-score-client': 'web' },
        payload: { token: custom.pairing.createToken() },
      })
      const headers = {
        'x-score-client': 'web',
        cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
      }
      const res = await custom.inject({
        method: 'PUT',
        url: `${W}/root`,
        headers,
        payload: { path: path.join(fakeHome, '.hermes') },
      })
      expect(res.statusCode).toBe(409)
    } finally {
      process.env.HOME = savedHome
      await custom.close()
    }
  })
})
