// An XMLHttpRequest a test drives by hand: it records the request, and the test fires progress events and then the
// answer. For checking what a person sees while an upload is out (data/api.ts apiUpload).
import { act } from '@testing-library/react'
import { vi } from 'vitest'

export class ControlledXhr {
  static all: ControlledXhr[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 200
  responseText = ''
  responseType = ''
  sent: unknown
  constructor() {
    ControlledXhr.all.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value
  }
  send(body: unknown) {
    this.sent = body
  }
  /** Bytes sent so far. */
  progress(loaded: number, total: number) {
    act(() => {
      this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent)
    })
  }
  /** The server's answer. */
  answer(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    act(() => this.onload?.())
  }
}

export function installControlledXhr() {
  ControlledXhr.all = []
  vi.stubGlobal('XMLHttpRequest', ControlledXhr)
}
