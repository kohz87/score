import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { dist } from './11.10a-config.mjs'
import {
  agents,
  approval,
  directChat,
  directMessages,
  directRoom,
  jobs,
  messages,
  outside,
  teamRoom,
} from './11.10a-fixtures.mjs'

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
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

export async function serve(route) {
  const url = new URL(route.request().url())
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (path === '/api/agents') return json(route, { asOfSeq: 12, items: agents })
    if (path === '/api/team-room') return json(route, { asOfSeq: 12, room: teamRoom, jobs })
    if (path === '/api/rooms')
      return json(route, { asOfSeq: 12, rooms: [], directs: [], projects: [] })
    if (path === '/api/outside-sessions') return json(route, { items: [outside], unavailable: [] })
    if (path === '/api/rooms/team-room/jobs') return json(route, { asOfSeq: 12, items: jobs })
    if (path === '/api/rooms/team-room/messages') {
      const jobId = url.searchParams.get('jobId') ?? 'job-default'
      return json(route, { asOfSeq: 12, items: messages[jobId] ?? [], nextCursor: null, jobId })
    }
    if (path === '/api/rooms/team-room/pins') return json(route, { items: [] })
    if (path === '/api/rooms/team-room/versions') return json(route, { asOfSeq: 12, items: [] })
    if (path === '/api/approvals')
      return json(route, { asOfSeq: 12, items: [approval], nextCursor: null })
    if (path === '/api/commands') return json(route, { items: [] })
    if (path === '/api/agents/builder/direct')
      return json(route, { asOfSeq: 12, room: directRoom, chats: [directChat] })
    if (/^\/api\/jobs\/[^/]+\/(results|workbench|exchanges)$/.test(path))
      return json(route, {
        asOfSeq: 12,
        items: [],
        screens: [],
        files: [],
        looseComments: [],
        drafts: [],
      })
    if (path === `/api/rooms/${directRoom.id}/messages`)
      return json(route, {
        asOfSeq: 12,
        items: directMessages,
        nextCursor: null,
        jobId: directChat.id,
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
