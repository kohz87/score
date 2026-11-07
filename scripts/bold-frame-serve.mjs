import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export function createServe({
  dist,
  fixtures,
  recipeFixtures,
  roomFixture,
  searchFixtures,
  contentTypes,
}) {
  return async function serve(route) {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/stream') return route.fulfill({ status: 204 })
      const room = roomFixture(url)
      if (room)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(room),
        })
      const searchFixture = searchFixtures[url.pathname]
      if (searchFixture)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(searchFixture),
        })
      // Reports requests carry the viewer's time zone; the visual fixture is keyed by range only.
      const reportFixture =
        url.pathname === '/api/reports'
          ? fixtures[`/api/reports?range=${url.searchParams.get('range') ?? '7d'}`]
          : undefined
      const fixture =
        recipeFixtures[url.pathname] ??
        fixtures[`${url.pathname}${url.search}`] ??
        reportFixture ??
        (url.pathname === '/api/reports' ? fixtures['/api/reports?range=7d'] : undefined) ??
        fixtures[url.pathname]
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          fixture ?? {
            asOfSeq: 0,
            items: [],
            rooms: [],
            directs: [],
            projects: [],
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          },
        ),
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
}
