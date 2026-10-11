import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import {
  findNoteImages,
  imagePlaceholder,
  restoreImages,
  withPlaceholders,
} from '../../src/knowledge/note-images.ts'
import { makeVault, type Harness } from './helpers.ts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (alt = 'pixel') => `![${alt}](data:image/png;base64,${PNG})`
const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')

let h: Harness
beforeEach(async () => {
  h = await makeVault()
})
afterEach(() => h.cleanup())

describe('embedded images in notes', () => {
  test('a valid image is stored exactly and read back whole by the owner', async () => {
    const body = `# Pic\n\n${png()}\n\nafter\n`
    const { etag } = await h.vault.writeNote('pic.md', { body, etag: null })
    const note = await h.vault.readNote('pic.md')
    expect(note.body).toBe(body)
    expect(note.etag).toBe(etag)
  })

  test('SVG and other types are refused (415), also with a lying magic number', async () => {
    const svg = `![x](data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')})`
    await expect(h.vault.writeNote('a.md', { body: svg, etag: null })).rejects.toMatchObject({
      status: 415,
      code: 'unsupported_type',
    })
    const text = `![x](data:text/html;base64,${Buffer.from('<b>').toString('base64')})`
    await expect(h.vault.writeNote('b.md', { body: text, etag: null })).rejects.toMatchObject({
      status: 415,
    })
    // Declared PNG, bytes are JPEG.
    const lie = `![x](data:image/png;base64,${jpegHead})`
    await expect(h.vault.writeNote('c.md', { body: lie, etag: null })).rejects.toMatchObject({
      status: 415,
    })
  })

  test('bad base64 is 400; an image over 1.5 MiB is 413; the whole note may reach 8 MiB', async () => {
    await expect(
      h.vault.writeNote('d.md', { body: '![x](data:image/png;base64,@@@@)', etag: null }),
    ).rejects.toMatchObject({ status: 400 })
    const header = Buffer.from(PNG, 'base64').subarray(0, 8)
    const big = Buffer.concat([header, Buffer.alloc(1.5 * 1024 * 1024)]).toString('base64')
    await expect(
      h.vault.writeNote('e.md', { body: `![big](data:image/png;base64,${big})`, etag: null }),
    ).rejects.toMatchObject({ status: 413, code: 'payload_too_large' })
    const ok = Buffer.concat([header, Buffer.alloc(1024 * 1024)]).toString('base64')
    const four = Array.from({ length: 4 }, (_, i) => `![p${i}](data:image/png;base64,${ok})`)
    const written = await h.vault.writeNote('f.md', { body: four.join('\n'), etag: null })
    expect(written.path).toBe('f.md')
  })

  test('a data URI inside code is plain text and is not validated', async () => {
    await expect(
      h.vault.writeNote('g.md', {
        body: '```\n![x](data:image/svg+xml;base64,AAAA)\n```\n',
        etag: null,
      }),
    ).resolves.toBeDefined()
  })

  test('search skips the base64: snippets and indexed text never contain it', async () => {
    await h.vault.writeNote('s.md', { body: `# Diagram\n\nwhiteboard ${png('sketch')}\n`, etag: null })
    const hits = h.vault.search('whiteboard', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).not.toContain('base64')
    expect(hits[0]!.snippet).not.toContain(PNG.slice(0, 20))
    expect(h.vault.search(PNG.slice(0, 24), 5)).toHaveLength(0)
    expect(h.vault.search('sketch', 5)).toHaveLength(1)
  })
})

describe('agents and embedded images', () => {
  let api: KnowledgeAgentApi
  beforeEach(() => {
    api = new KnowledgeAgentApi(h.vault, h.db)
  })

  test('read replaces each image with a placeholder', async () => {
    await h.vault.writeNote('r.md', { body: `# R\n${png('a chart')}\ntext\n`, etag: null })
    const read = await api.read('builder', 'r.md')
    expect(read.body).toBe('# R\n[image: a chart, 70 B]\ntext\n')
    expect(read.body).not.toContain('base64')
  })

  test('write refuses an added image', async () => {
    await expect(api.write('builder', 'n.md', `hi ${png()}`, null)).rejects.toMatchObject({
      status: 400,
      code: 'images_not_allowed',
    })
    await expect(api.append('builder', 'n.md', png())).rejects.toMatchObject({
      code: 'images_not_allowed',
    })
  })

  test('an edit that keeps the placeholders keeps the images; one that drops them deletes them', async () => {
    const first = await h.vault.writeNote('k.md', {
      body: `# K\n${png('one')}\nmiddle\n${png('two')}\n`,
      etag: null,
    })
    const read = await api.read('builder', 'k.md')
    const edited = read.body.replace('middle', 'MIDDLE EDITED')
    await api.write('builder', 'k.md', edited, first.etag)
    const after = await h.vault.readNote('k.md')
    expect(after.body).toBe(`# K\n${png('one')}\nMIDDLE EDITED\n${png('two')}\n`)
    const dropped = edited.replace('[image: one, 70 B]\n', '')
    await api.write('builder', 'k.md', dropped, after.etag)
    expect((await h.vault.readNote('k.md')).body).toBe(`# K\nMIDDLE EDITED\n${png('two')}\n`)
  })

  test('append leaves the images of the note alone', async () => {
    await h.vault.writeNote('p.md', { body: `${png('keep')}\n`, etag: null })
    await api.append('builder', 'p.md', 'more')
    expect((await h.vault.readNote('p.md')).body).toBe(`${png('keep')}\nmore`)
  })
})

describe('placeholder helpers', () => {
  test('alt text is cleaned and sizes are formatted', () => {
    const [image] = findNoteImages(png('a [b'))
    expect(imagePlaceholder(image!)).toBe('[image: a  b, 70 B]')
    expect(withPlaceholders('none')).toBe('none')
    expect(restoreImages('[image: x, 1 KB]', 'no images')).toBe('[image: x, 1 KB]')
  })
})
