import { AgentIdSchema } from '@score/contract'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {}
    // The contract exports string validation, but does not yet export an error-envelope schema.
    const code = AgentIdSchema.safeParse(error.code)
    const message = AgentIdSchema.safeParse(error.message)
    throw new ApiError(
      response.status,
      code.success ? code.data : 'request_failed',
      message.success ? message.data : 'The request failed. Please try again.',
      error.details,
    )
  }
  return response.status === 204 ? undefined : response.json()
}
