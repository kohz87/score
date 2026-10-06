import type { preHandlerHookHandler } from 'fastify'
import { HttpError } from '../errors.ts'
import type { PairingService } from './pairing.ts'

export function humanGuard(pairing: PairingService): preHandlerHookHandler {
  return async (request) => {
    if (!pairing.isPaired(request.headers.cookie)) {
      throw new HttpError(401, 'not_paired', 'Pair this browser to make human decisions')
    }
  }
}
