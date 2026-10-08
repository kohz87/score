import { ErrorEnvelopeSchema } from '@score/contract'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers.set('X-Score-Client', 'web')
    if (typeof init.body === 'string' && !headers.has('content-type'))
      headers.set('content-type', 'application/json')
  }
  const response = await fetch(`/api/${path.replace(/^\/+/, '')}`, {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const envelope = ErrorEnvelopeSchema.safeParse(payload)
    const error = envelope.success ? envelope.data.error : null
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The request failed. Please try again.',
      error?.details,
    )
  }
  return response.status === 204 ? undefined : response.json()
}
