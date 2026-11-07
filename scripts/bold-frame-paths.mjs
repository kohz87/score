import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const root = resolve(new URL('..', import.meta.url).pathname)
export const output = join(root, 'test-results')
export const dist = join(root, 'apps/web/dist')
// The sandbox may forbid listening sockets. Chromium routes every request for this origin from the built files instead:
// /b is still the built app's route, with no server and no port.
export const baseURL = 'http://score.local'
export const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href
export const board01 = pathToFileURL(join(root, 'docs/design/bold/01-team-room.dc.html')).href
export const board09 = pathToFileURL(join(root, 'docs/design/bold/09-empty-room.dc.html')).href
