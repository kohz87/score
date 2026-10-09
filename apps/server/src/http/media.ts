import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { parseSingleFile } from '../media/multipart.ts'
import { DOCX_TYPE, isTextType, XLSX_TYPE } from '../media/sniff.ts'
import type { MediaStore } from '../media/store.ts'

const ParamsSchema = z.object({ mediaId: z.string().min(1).max(64) })
const QuerySchema = z.object({
  download: z.enum(['1']).optional(),
  name: z.string().max(200).optional(),
})

function attachment(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '')
  const safe = cleaned.trim().slice(0, 120) || 'download'
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}

// Upload (H): one image or document in a multipart body, bounded by the route's body limit. Bytes are served back only
// from the index, with the sniffed type, by kind (images and text inline under a sandbox CSP, PDF inline, Word and Excel as downloads), never reinterpreted.
export function registerMediaRoutes(app: FastifyInstance, store: MediaStore): void {
  // The multipart parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    const limit = store.maxItemBytes + 64 * 1024
    scope.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: limit },
      (_request, body, done) => done(null, body),
    )
    scope.post(
      '/api/media',
      {
        bodyLimit: limit,
        // Before the body is read, so an unpaired caller can't make the server buffer megabytes.
        onRequest: async (request) => {
          if (!app.pairing.isPaired(request.headers.cookie))
            throw new HttpError(401, 'not_paired', 'Pair this browser to make human decisions')
        },
      },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'Malformed upload')
        const file = parseSingleFile(request.body, request.headers['content-type'])
        const stored = store.store(file.bytes, file.contentType, file.filename)
        return reply.code(201).send({
          mediaId: stored.mediaId,
          name: file.filename,
          size: stored.size,
          contentType: stored.contentType,
        })
      },
    )
    scope.get('/api/media/:mediaId', async (request, reply) => {
      const { mediaId } = ParamsSchema.parse(request.params)
      const query = QuerySchema.parse(request.query)
      const media = store.read(mediaId)
      if (!media) throw new HttpError(404, 'not_found', 'Media not found')
      void reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, max-age=3600')
        .header('ETag', `"${media.sha256}"`)
      // Word and Excel files, and any file asked for with download=1, are never shown by the browser itself.
      if (
        query.download === '1' ||
        media.contentType === DOCX_TYPE ||
        media.contentType === XLSX_TYPE
      )
        return reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', attachment(query.name))
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .send(media.bytes)
      // A PDF opens in the browser's own viewer, which does not work under a sandbox CSP; nothing else is exempt.
      if (media.contentType === 'application/pdf')
        return reply
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', 'inline')
          .send(media.bytes)
      // Text kinds, HTML included, are served as plain text: the HTML is only ever shown as source.
      return reply
        .header(
          'Content-Type',
          isTextType(media.contentType) ? 'text/plain; charset=utf-8' : media.contentType,
        )
        .header('Content-Disposition', 'inline')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(media.bytes)
    })
  })
}
