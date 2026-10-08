import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { parseSingleFile } from '../media/multipart.ts'
import type { MediaStore } from '../media/store.ts'

const ParamsSchema = z.object({ mediaId: z.string().min(1).max(64) })

// Upload (H): one image in a multipart body, bounded by the route's body limit. Bytes are served back only
// from the index, with the sniffed type, as an inline image that browsers must not reinterpret.
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
        const stored = store.store(file.bytes, file.contentType)
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
      const media = store.read(mediaId)
      if (!media) throw new HttpError(404, 'not_found', 'Media not found')
      return reply
        .header('Content-Type', media.contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=3600')
        .header('ETag', `"${media.sha256}"`)
        .send(media.bytes)
    })
  })
}
