import { ErrorEnvelopeSchema } from '@score/contract'
import { announceLogout, remoteTransport } from './session.ts'

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

/** Turns a failed response into an ApiError (and signs a remote browser out on 401), the same for fetch and XHR. */
function failure(path: string, status: number, payload: unknown): ApiError {
  const parsed = ErrorEnvelopeSchema.safeParse(payload)
  if (
    status === 401 &&
    remoteTransport() &&
    window.location.pathname !== '/pair' &&
    !path.replace(/^\/+/, '').startsWith('session')
  )
    announceLogout()
  return new ApiError(
    status,
    parsed.success ? parsed.data.error.code : 'request_failed',
    parsed.success ? parsed.data.error.message : 'Couldn’t complete that. Try again.',
    parsed.success ? parsed.data.error.details : undefined,
  )
}

export type UploadProgress = { loaded: number; total: number }

/** The bytes of a body, for a progress total when the browser can't say: a file, or every file in a form. */
function bodySize(body: Blob | FormData): number {
  if (body instanceof Blob) return body.size
  let size = 0
  for (const value of body.values()) size += typeof value === 'string' ? value.length : value.size
  return size
}

/**
 * A PUT of a file body that reports how much has been sent (fetch can't): XMLHttpRequest with the same headers and
 * errors as apiFetch. `onProgress` gets bytes sent; once all are sent the server is still working on them. A `Blob`
 * goes as `application/octet-stream`; a `FormData` (several files, a pet pack) is left to the browser, which sets its
 * multipart type and boundary. `headers` adds any more, such as an `Idempotency-Key`.
 */
export function apiUpload(
  path: string,
  body: Blob | FormData,
  onProgress?: (progress: UploadProgress) => void,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', `/api/${path.replace(/^\/+/, '')}`)
    request.setRequestHeader('X-Score-Client', 'web')
    if (body instanceof Blob) request.setRequestHeader('content-type', 'application/octet-stream')
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.responseType = 'text'
    if (onProgress)
      request.upload.onprogress = (event) =>
        onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : bodySize(body),
        })
    request.onload = () => {
      let payload: unknown
      try {
        payload = request.responseText ? JSON.parse(request.responseText) : null
      } catch {
        payload = null
      }
      if (request.status >= 200 && request.status < 300)
        resolve(request.status === 204 ? undefined : payload)
      else reject(failure(path, request.status, payload))
    }
    request.onerror = () =>
      reject(new ApiError(0, 'network_error', 'The connection dropped. Try again.'))
    request.send(body)
  })
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
    throw failure(path, response.status, payload)
  }
  return response.status === 204 ? undefined : response.json()
}
