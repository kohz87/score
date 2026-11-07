import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const root = resolve(new URL('../..', import.meta.url).pathname)
export const output = join(root, 'test-results')
export const dist = join(root, 'apps/web/dist')
export const baseURL = 'http://score.local'
export const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href
