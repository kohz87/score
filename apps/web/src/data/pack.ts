import { type Pack } from '../styles/packs.ts'

/** Sets the attributes the stylesheets read; fonts load once, on first use. */
export function applyPack(pack: Pack): void {
  const root = document.documentElement
  root.setAttribute('data-pack', pack.id)
  root.setAttribute('data-layout', pack.layout)
  root.setAttribute('data-density', pack.density)
  void pack.fonts?.().catch(() => {
    // The pack's fallback fonts show until the next visit.
  })
}
