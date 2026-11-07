import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { dist } from './11.4d-config.mjs'
import {
  agents,
  importedMessages,
  message,
  oldJob,
  olderRoom,
  outside,
  teamJobs,
  teamRoom,
} from './11.4d-fixtures.mjs'

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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

export async function serve(route) {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (path === '/api/agents') return json(route, { asOfSeq: 12, items: agents })
    if (path === '/api/team-room')
      return json(route, { asOfSeq: 12, room: teamRoom, jobs: teamJobs })
    if (path === '/api/rooms')
      return json(route, { asOfSeq: 12, rooms: [olderRoom], directs: [], projects: [] })
    if (path === '/api/outside-sessions') return json(route, { items: [outside], unavailable: [] })
    if (path === '/api/rooms/team-room/jobs') return json(route, { asOfSeq: 12, items: teamJobs })
    if (path === '/api/rooms/room-old')
      return json(route, { asOfSeq: 12, room: olderRoom, filesInPlay: [], learned: [] })
    if (path === '/api/rooms/room-old/jobs') return json(route, { asOfSeq: 12, items: [oldJob] })
    if (path === '/api/rooms/room-old/messages')
      return json(route, { asOfSeq: 12, items: [message], nextCursor: null, jobId: oldJob.id })
    if (path === '/api/outside-sessions/import')
      return json(route, { roomId: 'room-imported', imported: 2 })
    if (path === '/api/rooms/room-imported/messages')
      return json(route, {
        asOfSeq: 12,
        items: importedMessages,
        nextCursor: null,
        jobId: 'job-imported',
      })
    if (path.endsWith('/messages'))
      return json(route, {
        asOfSeq: 12,
        items: [],
        nextCursor: null,
        jobId: url.searchParams.get('jobId'),
      })
    if (path.endsWith('/pins')) return json(route, { items: [] })
    if (path.endsWith('/versions')) return json(route, { asOfSeq: 12, items: [] })
    if (path === '/api/approvals') return json(route, { asOfSeq: 12, items: [], nextCursor: null })
    if (path === '/api/commands') return json(route, { items: [] })
    if (/^\/api\/jobs\/[^/]+\/(results|workbench|exchanges)$/.test(path))
      return json(route, {
        asOfSeq: 12,
        items: [],
        screens: [],
        files: [],
        looseComments: [],
        drafts: [],
      })
    return json(route, { asOfSeq: 0, items: [], rooms: [], directs: [], projects: [] })
  }
  const requested = path === '/' ? '/index.html' : decodeURIComponent(path)
  let file = resolve(dist, `.${requested}`)
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile())
    file = join(dist, 'index.html')
  return route.fulfill({
    status: 200,
    contentType: contentTypes[extname(file)] ?? 'application/octet-stream',
    body: readFileSync(file),
  })
}
