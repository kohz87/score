import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRoot } from '../../src/workspace/policy.ts'
import { Workspace, etagOf } from '../../src/workspace/workspace.ts'
import { open, policy, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

describe('root protections (audit wave 4)', () => {
  it('refuses a root inside .git or a protected-name folder', async () => {
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n')
    expect((await checkRoot(path.join(root, '.git'), policy)).ok).toBe(false)
    expect((await checkRoot(path.join(root, '.git', 'objects'), policy)).ok).toBe(false)
    fs.mkdirSync(path.join(root, '.env.d'))
    expect((await checkRoot(path.join(root, '.env.d'), policy)).ok).toBe(false)
    await expect(Workspace.open(path.join(root, '.git'), policy)).rejects.toMatchObject({
      status: 409,
    })
  })

  it('does not replace a file an outside writer changed while the replacement was being prepared', async () => {
    const file = path.join(root, 'a.txt')
    fs.writeFileSync(file, 'v1')
    const ws = await open()
    const loaded = etagOf(Buffer.from('v1'))
    const handle = await fs.promises.open(file, 'r')
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> }
    await handle.close()
    const original = proto.sync
    proto.sync = async function (this: unknown) {
      // The agent writes during the save's fsync.
      fs.writeFileSync(file, 'agent version')
      return original.call(this)
    }
    try {
      await expect(ws.write('a.txt', 'mine', loaded)).rejects.toMatchObject({
        status: 412,
        code: 'precondition_failed',
      })
    } finally {
      proto.sync = original
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('agent version')
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.score-tmp'))).toEqual([])
  })
})
