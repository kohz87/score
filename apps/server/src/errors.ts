import type { FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'
import { redactLogError } from './logging.ts'

const FrameworkErrorSchema = z.object({
  statusCode: z.number().int().optional(),
  validation: z.unknown().optional(),
})

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler(() => {
    throw new HttpError(404, 'not_found', 'Couldn’t find that address.')
  })

  app.setErrorHandler((error, request, reply) => {
    const frameworkError = FrameworkErrorSchema.safeParse(error)
    const status = frameworkError.success ? frameworkError.data.statusCode : undefined
    let response: HttpError
    if (error instanceof HttpError) {
      response = error
    } else if (
      error instanceof ZodError ||
      (frameworkError.success && frameworkError.data.validation)
    ) {
      response = new HttpError(
        400,
        'bad_request',
        'Couldn’t read that request. Check what you entered and try again.',
      )
    } else if (status === 413) {
      response = new HttpError(413, 'payload_too_large', 'That request is too large to send.')
    } else if (status && status >= 400 && status < 500) {
      response = new HttpError(
        status,
        'bad_request',
        'Couldn’t read that request. Check what you entered and try again.',
      )
    } else {
      request.log.error({ err: redactLogError(error, request.headers) }, 'Internal server error')
      response = new HttpError(500, 'internal', 'Something went wrong inside Score. Try again.')
    }

    return reply.code(response.status).send({
      error: {
        code: response.code,
        message: response.message,
        ...(response.details === undefined ? {} : { details: response.details }),
      },
    })
  })
}
