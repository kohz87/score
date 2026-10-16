import { afterEach, describe, expect, test } from 'vitest'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

const PNG_A =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
// Same length (so the same size label), different bytes.
const PNG_B = PNG_A.replace('ADUlEQVR42mP8', 'ADUlEQVR42mP9')
const img = (alt: string, data = PNG_A) => `![${alt}](data:image/png;base64,${data})`

describe('S5-002 numbered image placeholders', () => {
  const setup = async () => {
    h = await makeVault()
    const api = new KnowledgeAgentApi(h.vault, h.db)
    const note = `# Pics\n${img('same', PNG_A)}\nmiddle\n${img('same', PNG_B)}\n`
    const first = await h.vault.writeNote('pics.md', { body: note, etag: null })
    return { api, first }
  }

  test('the agent reads a number for each image, even when label and size are equal', async () => {
    const { api } = await setup()
    const read = await api.read('builder', 'pics.md')
    expect(read.body).toBe('# Pics\n[image 1: same, 70 B]\nmiddle\n[image 2: same, 70 B]\n')
  })

  test('deleting the first of two equal-looking images deletes that one, not the other', async () => {
    const { api, first } = await setup()
    await api.write('builder', 'pics.md', '# Pics\nmiddle\n[image 2: same, 70 B]\n', first.etag)
    expect((await h!.vault.readNote('pics.md')).body).toBe(
      `# Pics\nmiddle\n${img('same', PNG_B)}\n`,
    )
  })

  test('deleting the second keeps the first', async () => {
    const { api, first } = await setup()
    await api.write('builder', 'pics.md', '# Pics\n[image 1: same, 70 B]\nmiddle\n', first.etag)
    expect((await h!.vault.readNote('pics.md')).body).toBe(
      `# Pics\n${img('same', PNG_A)}\nmiddle\n`,
    )
  })

  test('reordering the placeholders reorders the images', async () => {
    const { api, first } = await setup()
    await api.write(
      'builder',
      'pics.md',
      '# Pics\n[image 2: same, 70 B]\nmiddle\n[image 1: same, 70 B]\n',
      first.etag,
    )
    expect((await h!.vault.readNote('pics.md')).body).toBe(
      `# Pics\n${img('same', PNG_B)}\nmiddle\n${img('same', PNG_A)}\n`,
    )
  })

  test('a duplicated placeholder restores the image once; the copy stays text', async () => {
    const { api, first } = await setup()
    await api.write(
      'builder',
      'pics.md',
      '# Pics\n[image 1: same, 70 B]\n[image 1: same, 70 B]\n',
      first.etag,
    )
    expect((await h!.vault.readNote('pics.md')).body).toBe(
      `# Pics\n${img('same', PNG_A)}\n[image 1: same, 70 B]\n`,
    )
  })

  test('a number the note does not have, or a label that does not match, is never another image', async () => {
    const { api, first } = await setup()
    await api.write(
      'builder',
      'pics.md',
      '# Pics\n[image 9: same, 70 B]\n[image 1: other, 70 B]\n[image 2: same, 5 KB]\n',
      first.etag,
    )
    const body = (await h!.vault.readNote('pics.md')).body
    expect(body).toBe(
      '# Pics\n[image 9: same, 70 B]\n[image 1: other, 70 B]\n[image 2: same, 5 KB]\n',
    )
    expect(body).not.toContain('base64')
  })

  test('an old placeholder without a number: restored when unique, refused when ambiguous', async () => {
    h = await makeVault()
    const api = new KnowledgeAgentApi(h.vault, h.db)
    const one = await h.vault.writeNote('one.md', { body: `${img('solo')}\n`, etag: null })
    await api.write('builder', 'one.md', 'text\n[image: solo, 70 B]\n', one.etag)
    expect((await h.vault.readNote('one.md')).body).toBe(`text\n${img('solo')}\n`)

    const two = await h.vault.writeNote('two.md', {
      body: `${img('same', PNG_A)}\n${img('same', PNG_B)}\n`,
      etag: null,
    })
    await expect(
      api.write('builder', 'two.md', '[image: same, 70 B]\n', two.etag),
    ).rejects.toMatchObject({ status: 409, code: 'ambiguous_image' })
    // Nothing was written.
    expect((await h.vault.readNote('two.md')).etag).toBe(two.etag)
  })
})
