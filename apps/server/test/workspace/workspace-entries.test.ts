import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, events, open, outside, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

describe('entries', () => {
  it('creates files and folders, refuses duplicates', async () => {
    const ws = await open()
    await ws.create('docs', 'dir')
    await ws.create('docs/new.md', 'file')
    expect(fs.statSync(path.join(root, 'docs')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(root, 'docs', 'new.md'), 'utf8')).toBe('')
    expect(await code(ws.create('docs', 'dir'))).toBe('409:exists')
    expect(await code(ws.create('docs/new.md', 'file'))).toBe('409:exists')
    expect(await code(ws.create('a/b/c', 'dir'))).toBe('404:not_found')
    expect(events.map((e) => e.op)).toEqual(['mkdir', 'create'])
  })
  it('moves files and folders, never overwrites, never moves a folder into itself', async () => {
    fs.mkdirSync(path.join(root, 'src', 'inner'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    const ws = await open()
    await ws.move('a.txt', 'src/a2.txt')
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'src', 'a2.txt'), 'utf8')).toBe('a')
    expect(await code(ws.move('b.txt', 'src/a2.txt'))).toBe('409:exists')
    expect(fs.readFileSync(path.join(root, 'src', 'a2.txt'), 'utf8')).toBe('a')
    expect(await code(ws.move('src', 'src/inner/src'))).toBe('400:bad_path')
    expect(await code(ws.move('nope', 'x'))).toBe('404:not_found')
    await ws.move('src', 'lib')
    expect(fs.existsSync(path.join(root, 'lib', 'inner'))).toBe(true)
    expect(await code(ws.move('b.txt', 'b.txt'))).toBe('409:exists')
    expect(events.find((e) => e.op === 'move')).toMatchObject({ path: 'a.txt', to: 'src/a2.txt' })
  })
  it('deletes files, empty folders; non-empty folders need recursive; symlinks inside are unlinked, not followed', async () => {
    fs.mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'tree', 'sub', 'f.txt'), 'f')
    fs.symlinkSync(outside, path.join(root, 'tree', 'sub', 'out'))
    fs.writeFileSync(path.join(root, 'one.txt'), '1')
    fs.mkdirSync(path.join(root, 'empty'))
    const ws = await open()
    await ws.remove('one.txt', false)
    await ws.remove('empty', false)
    expect(await code(ws.remove('tree', false))).toBe('409:not_empty')
    expect(fs.existsSync(path.join(root, 'tree'))).toBe(true)
    await ws.remove('tree', true)
    expect(fs.existsSync(path.join(root, 'tree'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
    expect(await code(ws.remove('', true))).toBe('400:bad_path')
    expect(await code(ws.remove('gone', false))).toBe('404:not_found')
  })
  it('uploads raw bytes, refuses existing files and sizes over 25 MiB', async () => {
    const ws = await open()
    const bytes = Buffer.from([0, 1, 2, 3, 255])
    await ws.upload('data.bin', bytes)
    expect(fs.readFileSync(path.join(root, 'data.bin'))).toEqual(bytes)
    expect(await code(ws.upload('data.bin', bytes))).toBe('409:exists')
    expect(await code(ws.upload('huge.bin', Buffer.alloc(25 * 1024 * 1024 + 1)))).toBe(
      '413:payload_too_large',
    )
    expect(fs.existsSync(path.join(root, 'huge.bin'))).toBe(false)
    expect(events[0]).toMatchObject({ op: 'upload', path: 'data.bin', size: 5 })
  })
})
