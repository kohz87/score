import { join, resolve } from 'node:path'

export const root = resolve(new URL('../..', import.meta.url).pathname)
export const output = join(root, 'test-results')
export const dist = join(root, 'apps/web/dist')
export const baseURL = 'http://score.local'
