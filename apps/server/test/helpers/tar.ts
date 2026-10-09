import { gzipSync } from 'node:zlib'

export interface TarEntry {
  name: string
  /** File contents; omit for a directory. */
  body?: string | Buffer
  /** Tar type flag override: '2' symlink, '1' hardlink, '3' device… */
  type?: string
  link?: string
}

/** Minimal GNU-style tar writer for tests (long names via an "L" record, like Python's GNU format). */
export function tarBytes(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  const record = (name: string, type: string, body: Buffer, link = '') => {
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 100), 0, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write(type, 156)
    header.write(link, 157, 'utf8')
    header.write('ustar  \0', 257)
    const sum = header.reduce((total, byte) => total + byte, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    if (Buffer.byteLength(entry.name) > 100)
      record('././@LongLink', 'L', Buffer.from(`${entry.name}\0`))
    record(entry.name, entry.type ?? (entry.body === undefined ? '5' : '0'), body, entry.link)
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

export function tarGz(entries: TarEntry[]): Buffer {
  return gzipSync(tarBytes(entries))
}

/** A realistic exported agent: config, description, skills, a plugin and memory; no credentials. */
export function sampleProfile(root = 'scout', extra: TarEntry[] = []): Buffer {
  return tarGz([
    { name: `${root}/` },
    {
      name: `${root}/config.yaml`,
      body: 'model:\n  default: example/model-1\n  provider: example\n_config_version: 31\n',
    },
    { name: `${root}/profile.yaml`, body: 'description: Reads and summarizes\n' },
    { name: `${root}/SOUL.md`, body: '# Scout\n' },
    { name: `${root}/skills/` },
    { name: `${root}/skills/research/web/SKILL.md`, body: '# web' },
    { name: `${root}/plugins/` },
    { name: `${root}/plugins/notes/plugin.yaml`, body: 'name: notes\n' },
    { name: `${root}/memories/MEMORY.md`, body: 'x'.repeat(1234) },
    ...extra,
  ])
}
