import { expect, test } from 'vitest'
import { parseSingleFile } from '../src/media/multipart.ts'
import { multipart } from './media-fixtures.ts'

test('non-ASCII filenames survive parsing as UTF-8', () => {
  for (const name of ['日本語.txt', 'naïve résumé.md', 'файл.csv']) {
    const { body, contentType } = multipart([{ name: 'file', filename: name, data: Buffer.from('x') }])
    expect(parseSingleFile(body, contentType).filename).toBe(name)
  }
})
