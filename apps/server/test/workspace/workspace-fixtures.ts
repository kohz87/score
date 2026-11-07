import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach } from 'vitest'
import { WorkspaceError, type RootPolicy } from '../../src/workspace/policy.ts'
import { Workspace, type WriteEvent } from '../../src/workspace/workspace.ts'

export let base: string
export let home: string
export let root: string
export let outside: string
export let policy: RootPolicy
export let events: WriteEvent[]
export let n = 0

export function setupWorkspace() {
  const createdBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-ws-test-')))
  base = createdBase
  n = 0
  afterAll(() => fs.rmSync(createdBase, { recursive: true, force: true }))

  beforeEach(() => {
    const dir = path.join(base, String(++n))
    home = path.join(dir, 'home')
    root = path.join(home, 'project')
    outside = path.join(dir, 'outside')
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(home, '.hermes'))
    fs.writeFileSync(path.join(home, '.hermes', 'secret.txt'), 'hermes')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
    policy = {
      home,
      forbidden: [path.join(home, '.hermes'), path.join(home, '.score'), path.join(home, '.ssh')],
    }
    events = []
  })
}

export const open = () => Workspace.open(root, policy, (event) => events.push(event))

export async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceError) return `${error.status}:${error.code}`
    throw error
  }
  return 'ok'
}
