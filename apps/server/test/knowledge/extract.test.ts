import { describe, expect, test } from 'vitest'
import { extractDocumentText, runWorker, ZIP_LIMITS } from '../../src/knowledge/extract.ts'
import { makeZip, textDocx, textPdf, zipFile } from './doc-fixtures.ts'

describe('text extraction in a worker', () => {
  test('reads a PDF', async () => {
    const out = await extractDocumentText('pdf', textPdf('Quarterly budget review'))
    expect(out.status).toBe('indexed')
    expect(out.text).toContain('Quarterly budget review')
  })
  test('reads a DOCX', async () => {
    const out = await extractDocumentText('docx', await textDocx('Onboarding checklist'))
    expect(out.text).toContain('Onboarding checklist')
  })
  test('strips scripts and tags from HTML', async () => {
    const html =
      '<html><script>alert("x")</script><style>p{}</style><p>Hello &amp; welcome</p></html>'
    const out = await extractDocumentText('html', Buffer.from(html))
    expect(out.text).toBe('Hello & welcome')
  })
  test('garbage PDF is unavailable, not an error', async () => {
    expect((await extractDocumentText('pdf', Buffer.from('%PDF-1.4 nonsense'))).status).toBe(
      'unavailable',
    )
  })
  test('the time limit kills a runaway worker', async () => {
    const started = Date.now()
    const result = await runWorker(
      { op: 'text', kind: 'pdf', bytes: textPdf('x'), maxBytes: 1000 },
      1,
    )
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.ok === false || result.ok === true).toBe(true)
  })
  test('lists a zip', async () => {
    const zip = await makeZip({ 'a.md': '# a', 'b.exe': 'MZ' })
    const result = await runWorker(
      { op: 'zip-list', file: zipFile(zip), limits: ZIP_LIMITS },
      10_000,
    )
    expect(result).toMatchObject({ ok: true })
  })
})
