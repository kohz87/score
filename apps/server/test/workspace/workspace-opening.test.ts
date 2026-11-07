import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Workspace } from '../../src/workspace/workspace.ts'
import { base, home, n, policy, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

describe('opening', () => {
  it('refuses a root that fails the policy at open time', async () => {
    await expect(Workspace.open(path.join(home, '.hermes'), policy)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_unavailable',
    })
  })
  it('keeps working when the root is reached through a symlinked path, and stops if it is swapped for a forbidden folder', async () => {
    const alias = path.join(base, `alias-${n}`)
    fs.symlinkSync(root, alias)
    fs.writeFileSync(path.join(root, 'x.txt'), 'x')
    const ws = await Workspace.open(alias, policy)
    expect(await ws.read('x.txt')).toMatchObject({ kind: 'text' })
    fs.rmSync(alias)
    fs.symlinkSync(path.join(home, '.hermes'), alias)
    await expect(Workspace.open(alias, policy)).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
  })
})
