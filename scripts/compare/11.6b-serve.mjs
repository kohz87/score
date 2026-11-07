import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { dist } from './11.6b-config.mjs'
import { agents, approval, job, room, watch, workbench } from './11.6b-fixtures.mjs'

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function serve(route) {
  const url = new URL(route.request().url())
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/stream') return route.fulfill({ status: 204 })
    let body
    if (url.pathname === '/api/agents') body = { asOfSeq: 12, items: agents }
    else if (url.pathname === '/api/team-room') body = { asOfSeq: 12, room, jobs: [job] }
    else if (url.pathname === '/api/jobs/job-feed/workbench') body = workbench
    else if (url.pathname === '/api/agents/builder/watch') body = watch
    else if (url.pathname === '/api/approvals')
      body = { asOfSeq: 12, items: [approval], nextCursor: null }
    else if (url.pathname === '/api/watch/overview') body = { asOfSeq: 12, items: [] }
    else if (url.pathname === '/api/system')
      body = {
        mode: 'fake',
        hermes: {
          version: null,
          reachable: true,
          apiServer: true,
          capabilities: [],
          servedProfiles: ['builder'],
        },
        bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
        compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
        agentIsolation: 'same_user',
        degraded: [],
      }
    else body = { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  }
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  let file = resolve(dist, `.${requested}`)
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile())
    file = join(dist, 'index.html')
  return route.fulfill({
    status: 200,
    contentType: contentTypes[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  })
}
