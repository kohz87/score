// Tests stub `fetch`; uploads use XMLHttpRequest for their progress (data/api.ts apiUpload). This stand-in sends every
// XMLHttpRequest through whatever `fetch` the test installed, and reports the whole body as sent before the response.
class XhrViaFetch {
  status = 0
  responseText = ''
  responseType = ''
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private method = 'GET'
  private url = ''
  private headers = new Headers()

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value)
  }

  send(body?: Blob | FormData | string | null) {
    let size = body instanceof Blob ? body.size : typeof body === 'string' ? body.length : 0
    if (body instanceof FormData)
      for (const value of body.values())
        size += typeof value === 'string' ? value.length : value.size
    this.upload.onprogress?.({ loaded: size, total: size, lengthComputable: true } as ProgressEvent)
    void globalThis
      .fetch(this.url, {
        method: this.method,
        headers: this.headers,
        ...(body == null ? {} : { body }),
      })
      .then(async (response) => {
        this.status = response.status
        this.responseText = await response.text()
        this.onload?.()
      })
      .catch(() => this.onerror?.())
  }
}

Object.defineProperty(globalThis, 'XMLHttpRequest', {
  value: XhrViaFetch,
  writable: true,
  configurable: true,
})
