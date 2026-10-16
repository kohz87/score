import { findPack, packs, type Pack } from '../styles/packs.ts'

const STORAGE_KEY = 'score.look'

export function readPackId(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const id = raw ? (JSON.parse(raw) as { pack?: unknown }).pack : null
    return typeof id === 'string' ? findPack(id).id : packs[0].id
  } catch {
    return packs[0].id
  }
}

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

/**
 * The boot script (public/boot-look.js) can't import this file, so the attributes are stored with the id and it
 * applies them before first paint.
 */
export function savePack(pack: Pack): void {
  try {
    if (pack.id === packs[0].id) window.localStorage.removeItem(STORAGE_KEY)
    else
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ pack: pack.id, layout: pack.layout, density: pack.density }),
      )
  } catch {
    // Private windows and blocked storage still switch for this visit.
  }
  applyPack(pack)
}
