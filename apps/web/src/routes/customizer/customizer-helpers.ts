import type { Draft, Mode } from '../../themes/customizer/draft.ts'

export function systemMode(): Mode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const hasSettings = (m: Draft['manifest']) =>
  !!(m.colors || m.fonts || m.shape || m.layout || m.background || m.views)
