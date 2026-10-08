import { HttpError } from '../errors.ts'

const bad = () => new HttpError(400, 'bad_request', 'Malformed upload')
const CRLF = Buffer.from('\r\n')

// Just enough multipart/form-data for one image field: the composer sends a single file part named "file".
// Anything else (extra file parts, truncated bodies, odd boundaries) is rejected rather than interpreted.
export function parseSingleFile(
  body: Buffer,
  contentType: string | undefined,
): { filename: string; bytes: Buffer; contentType: string | undefined } {
  const boundary = /boundary=(?:"([^"\r\n]{1,70})"|([^;\s"]{1,70}))/i.exec(contentType ?? '')
  const token = boundary?.[1] ?? boundary?.[2]
  if (!token) throw bad()
  const open = Buffer.from(`--${token}`)
  const separator = Buffer.from(`\r\n--${token}`)
  if (!body.subarray(0, open.length).equals(open)) throw bad()
  let position = open.length
  const files: { filename: string; bytes: Buffer; contentType: string | undefined }[] = []
  for (let parts = 0; ; parts += 1) {
    if (body.subarray(position, position + 2).toString('latin1') === '--') break
    if (parts >= 8 || !body.subarray(position, position + 2).equals(CRLF)) throw bad()
    position += 2
    const headerEnd = body.indexOf('\r\n\r\n', position)
    if (headerEnd < 0) throw bad()
    const headers = body.subarray(position, headerEnd).toString('latin1')
    const dataStart = headerEnd + 4
    const next = body.indexOf(separator, dataStart)
    if (next < 0) throw bad()
    const disposition = /^content-disposition:([^\r\n]*)/im.exec(headers)?.[1] ?? ''
    if (/[;\s]name="file"/i.test(disposition) && /filename=/i.test(disposition)) {
      const name = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? ''
      files.push({
        filename: safeName(name),
        bytes: body.subarray(dataStart, next),
        contentType: /^content-type:\s*([^\r\n]*)/im.exec(headers)?.[1]?.trim(),
      })
    }
    position = next + separator.length
  }
  if (files.length !== 1) throw bad()
  return files[0]!
}

// Only ever echoed back to the client: strip directories, control characters and absurd lengths.
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120)
  return cleaned || 'image'
}
