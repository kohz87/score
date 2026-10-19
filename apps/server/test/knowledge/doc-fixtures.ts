import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

/** A one-page PDF with real structure (xref table), so a PDF parser can read `text` back. */
export function textPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 700 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

/** A minimal but valid .docx holding `text` in one paragraph. */
export async function textDocx(text: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
])

/** Builds a zip from name -> content; `raw` options pass through to JSZip (e.g. unixPermissions for a symlink). */
export async function makeZip(
  files: Record<
    string,
    string | Buffer | { data: string | Buffer; unixPermissions?: number; dir?: boolean }
  >,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE',
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string' || Buffer.isBuffer(value))
      zip.file(name, value, { createFolders: false })
    else
      zip.file(name, value.data, {
        createFolders: false,
        ...(value.unixPermissions !== undefined ? { unixPermissions: value.unixPermissions } : {}),
        ...(value.dir ? { dir: true } : {}),
      })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression,
    platform: 'UNIX',
  })
}

/** Writes a zip to a temporary file (the zip worker reads its input from disk); returns the path. */
export function zipFile(bytes: Buffer): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'score-test-zip-')), 'in.zip')
  fs.writeFileSync(file, bytes)
  return file
}
