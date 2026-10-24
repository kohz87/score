import {
  BUILTIN_THEME_IDS,
  ThemeManifestSchema,
  cssAssetPaths,
  type ThemeManifest,
} from '@score/contract'
import { destinations } from '../../shell/destinations.ts'

// The Customizer's draft (PLAN 9.4): the manifest, the CSS as typed and the files not saved yet. Everything here is
// pure; the React side only holds a History and calls these. The draft is a value: nothing in it is applied to the
// page, stored or announced until the person saves and uses it.

export type Draft = {
  manifest: ThemeManifest
  css: string
  /** Files added in this session, by asset path (`fonts/a.woff2`, `img/background.webp`). */
  uploads: Readonly<Record<string, Uint8Array>>
  /** Licence texts (`LICENSE`, `OFL.txt`) of the theme this one was opened or copied from; they travel with it. */
  licenses?: Readonly<Record<string, string>>
}

type Mutable = ThemeManifest
type Layout = NonNullable<Mutable['layout']>

export function emptyManifest(id: string, name: string): ThemeManifest {
  return { format: 1, id, name, version: '1.0.0' }
}

/** Drops what carries no setting (undefined, empty groups) so a saved manifest says only what it changes. */
export function tidy(manifest: ThemeManifest): ThemeManifest {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(prune)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        const cleaned = prune(item)
        if (cleaned === undefined) continue
        if (key === 'faces' && Array.isArray(cleaned) && cleaned.length === 0) continue
        if (
          cleaned &&
          typeof cleaned === 'object' &&
          !Array.isArray(cleaned) &&
          Object.keys(cleaned).length === 0
        )
          continue
        out[key] = cleaned
      }
      return out
    }
    return value
  }
  const cleaned = prune(manifest) as ThemeManifest
  // A background without a picture has nothing to say: fit and dim only matter with one.
  if (cleaned.background && !cleaned.background.image) delete cleaned.background
  return cleaned
}

function patch(draft: Draft, change: (manifest: Mutable) => void): Draft {
  const manifest = structuredClone(draft.manifest)
  change(manifest)
  return { ...draft, manifest: tidy(manifest) }
}

export function setCss(draft: Draft, css: string): Draft {
  return css === draft.css ? draft : { ...draft, css }
}

export function setDetails(
  draft: Draft,
  details: Partial<Pick<ThemeManifest, 'name' | 'author' | 'version' | 'description' | 'id'>>,
): Draft {
  return patch(draft, (m) => {
    Object.assign(m, details)
    for (const key of ['author', 'description'] as const) if (m[key] === '') delete m[key]
  })
}

export type Mode = 'light' | 'dark'
export function setColor(
  draft: Draft,
  mode: Mode,
  token: keyof NonNullable<NonNullable<Mutable['colors']>['light']>,
  value: string | undefined,
): Draft {
  return patch(draft, (m) => {
    const colors = (m.colors ??= {})
    const set = (colors[mode] ??= {})
    if (value === undefined) delete set[token]
    else set[token] = value
  })
}

export function setShape<K extends keyof NonNullable<Mutable['shape']>>(
  draft: Draft,
  key: K,
  value: NonNullable<Mutable['shape']>[K] | undefined,
): Draft {
  return patch(draft, (m) => {
    const shape = (m.shape ??= {})
    if (value === undefined) delete shape[key]
    else shape[key] = value
  })
}

export function setLayoutKey<K extends 'nav' | 'contentWidth'>(
  draft: Draft,
  key: K,
  value: Layout[K] | undefined,
): Draft {
  return patch(draft, (m) => {
    const layout = (m.layout ??= {})
    if (value === undefined) delete layout[key]
    else layout[key] = value
  })
}

export function setChat<K extends 'messages' | 'roomList'>(
  draft: Draft,
  key: K,
  value: NonNullable<Layout['chat']>[K] | undefined,
): Draft {
  return patch(draft, (m) => {
    const chat = ((m.layout ??= {}).chat ??= {})
    if (value === undefined) delete chat[key]
    else chat[key] = value
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Fonts

export type FontKey = 'heading' | 'body' | 'code'
export function setFontFamily(draft: Draft, key: FontKey, family: string | undefined): Draft {
  return patch(draft, (m) => {
    const fonts = (m.fonts ??= {})
    if (family === undefined) delete fonts[key]
    else fonts[key] = family
  })
}

export type Face = NonNullable<NonNullable<Mutable['fonts']>['faces']>[number]

/** `Brand Sans` -> `brand-sans`. */
export function slug(text: string, fallback: string): string {
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return out || fallback
}

export function addFace(draft: Draft, face: Face, bytes: Uint8Array): Draft {
  const path = face.src.slice('asset:'.length)
  const next = patch(draft, (m) => {
    const fonts = (m.fonts ??= {})
    fonts.faces = [...(fonts.faces ?? []).filter((item) => item.src !== face.src), face]
  })
  return { ...next, uploads: { ...next.uploads, [path]: bytes } }
}

export function removeFace(draft: Draft, src: string): Draft {
  const family = draft.manifest.fonts?.faces?.find((face) => face.src === src)?.family
  const next = patch(draft, (m) => {
    const fonts = m.fonts
    if (!fonts) return
    fonts.faces = (fonts.faces ?? []).filter((face) => face.src !== src)
    // A role that used this family goes back to Score's font when no other face carries it.
    if (family && !fonts.faces.some((face) => face.family === family))
      for (const key of ['heading', 'body', 'code'] as const)
        if (fonts[key] === family) delete fonts[key]
  })
  const uploads = { ...next.uploads }
  delete uploads[src.slice('asset:'.length)]
  return { ...next, uploads }
}

// ---------------------------------------------------------------------------------------------------------------
// Background

export function setBackgroundImage(draft: Draft, ref: string, bytes: Uint8Array): Draft {
  const path = ref.slice('asset:'.length)
  const next = patch(draft, (m) => {
    m.background = { fit: m.background?.fit ?? 'cover', dim: m.background?.dim ?? 0, image: ref }
  })
  return {
    ...next,
    uploads: { ...dropUpload(next.uploads, draft.manifest.background?.image), [path]: bytes },
  }
}

export function clearBackground(draft: Draft): Draft {
  const next = patch(draft, (m) => {
    delete m.background
  })
  return { ...next, uploads: dropUpload(next.uploads, draft.manifest.background?.image) }
}

function dropUpload(
  uploads: Readonly<Record<string, Uint8Array>>,
  ref: string | undefined,
): Record<string, Uint8Array> {
  const out = { ...uploads }
  if (ref) delete out[ref.slice('asset:'.length)]
  return out
}

export function setBackgroundFit(draft: Draft, fit: 'cover' | 'tile'): Draft {
  return patch(draft, (m) => {
    if (m.background) m.background.fit = fit
  })
}
export function setBackgroundDim(draft: Draft, dim: number): Draft {
  return patch(draft, (m) => {
    if (m.background) m.background.dim = Math.min(80, Math.max(0, Math.round(dim)))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Menu

export type MenuRow = { to: (typeof destinations)[number]['path']; label?: string; hidden: boolean }
const titleOf = (to: string) => destinations.find((item) => item.path === to)?.title ?? to

/** The menu as the editor lists it: shown entries in order, then the hidden ones. Settings is always shown. */
export function menuRows(manifest: ThemeManifest): MenuRow[] {
  const menu = manifest.layout?.menu
  const all = destinations.map((item) => item.path)
  if (!menu) return all.map((to) => ({ to, hidden: false }))
  const shown: MenuRow[] = []
  for (const entry of menu) {
    if (shown.some((row) => row.to === entry.to)) continue
    // Themes saved before 11.11 may still name /now or /tasks. The manifest keeps accepting them, but the
    // Customizer only offers the destinations that still exist.
    const known = destinations.find((item) => item.path === entry.to)
    if (known)
      shown.push({ to: known.path, ...(entry.label ? { label: entry.label } : {}), hidden: false })
  }
  if (!shown.some((row) => row.to === '/settings')) shown.push({ to: '/settings', hidden: false })
  const hidden = all
    .filter((to) => !shown.some((row) => row.to === to))
    .map((to): MenuRow => ({ to, hidden: true }))
  return [...shown, ...hidden]
}

export function menuLabel(row: MenuRow): string {
  return row.label ?? titleOf(row.to)
}

/** Writes the rows back. A menu equal to Score's own is not stored at all. */
export function setMenuRows(draft: Draft, rows: MenuRow[]): Draft {
  const shown = rows.filter((row) => !row.hidden || row.to === '/settings')
  const isDefault =
    shown.length === destinations.length &&
    shown.every((row, index) => row.to === destinations[index]?.path && !row.label)
  return patch(draft, (m) => {
    const layout = (m.layout ??= {})
    if (isDefault) delete layout.menu
    else
      layout.menu = shown.map((row) => ({
        to: row.to,
        ...(row.label ? { label: row.label } : {}),
      }))
  })
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** Moves a row among the shown ones (the hidden rows stay below). */
export function moveMenuRow(draft: Draft, from: number, to: number): Draft {
  const rows = menuRows(draft.manifest)
  const shown = rows.filter((row) => !row.hidden)
  const hidden = rows.filter((row) => row.hidden)
  return setMenuRows(draft, [...moveItem(shown, from, to), ...hidden])
}

export function renameMenuRow(draft: Draft, to: string, label: string): Draft {
  const rows = menuRows(draft.manifest).map((row) => {
    if (row.to !== to) return row
    const rest = { to: row.to, hidden: row.hidden }
    const text = label.trim().slice(0, 24)
    return text && text !== titleOf(to) ? { ...rest, label: text } : rest
  })
  return setMenuRows(draft, rows)
}

export function hideMenuRow(draft: Draft, to: string, hidden: boolean): Draft {
  if (to === '/settings') return draft
  const rows = menuRows(draft.manifest)
  const shown = rows.filter((row) => !row.hidden && row.to !== to)
  const kept = rows.find((row) => row.to === to)
  const others = rows.filter((row) => row.hidden && row.to !== to)
  if (!kept) return draft
  return hidden
    ? setMenuRows(draft, [...shown, ...others, { to: kept.to, hidden: true }])
    : setMenuRows(draft, [...shown, { to: kept.to, hidden: false }, ...others])
}

export function resetMenu(draft: Draft): Draft {
  return patch(draft, (m) => {
    if (m.layout) delete m.layout.menu
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Assets and checks

/** Every `asset:` the draft points at (manifest and CSS), as `fonts/x.woff2`. */
export function referencedAssets(draft: Draft): string[] {
  const found = new Set<string>()
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      if (node.startsWith('asset:')) found.add(node.slice('asset:'.length))
    } else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(draft.manifest)
  for (const path of cssAssetPaths(draft.css)) found.add(path)
  return [...found].sort()
}

const hashes = new WeakMap<Uint8Array, string>()
/** A fingerprint of a file's bytes (length and two cheap sums), so a replacement at the same path is a change. */
export function fingerprint(bytes: Uint8Array): string {
  let known = hashes.get(bytes)
  if (known === undefined) {
    let fnv = 0x811c9dc5
    let sum = 0
    for (let i = 0; i < bytes.length; i++) {
      fnv = Math.imul(fnv ^ bytes[i]!, 0x01000193) >>> 0
      sum = (sum + bytes[i]! * ((i % 251) + 1)) >>> 0
    }
    known = `${bytes.length}:${fnv.toString(16)}:${sum.toString(16)}`
    hashes.set(bytes, known)
  }
  return known
}

const uploadsKey = (uploads: Draft['uploads']) =>
  Object.keys(uploads)
    .sort()
    .map((path) => `${path}=${fingerprint(uploads[path]!)}`)
    .join('|')

export function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.css === b.css &&
    JSON.stringify(a.manifest) === JSON.stringify(b.manifest) &&
    uploadsKey(a.uploads) === uploadsKey(b.uploads)
  )
}

/** The reasons the manifest can't be saved, in plain words (empty when it can). */
export function manifestProblems(manifest: ThemeManifest): string[] {
  const parsed = ThemeManifestSchema.safeParse(manifest)
  if (parsed.success) return []
  const out = new Set<string>()
  for (const issue of parsed.error.issues) {
    const where = issue.path[0]
    if (where === 'name') out.add('Give the theme a name (1–60 characters).')
    else if (where === 'id') out.add('The theme’s address can only use a–z, 0–9 and dashes.')
    else if (where === 'version') out.add('The version should look like 1.0.0.')
    else if (where === 'author') out.add('The author is longer than 80 characters.')
    else if (where === 'description') out.add('The description is longer than 400 characters.')
    else out.add(`Something in “${String(where)}” isn’t valid: ${issue.message}.`)
  }
  return [...out]
}

export function isReservedId(id: string): boolean {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id)
}

/** A free id for a name: `my-theme`, `my-theme-2`, … never a built-in's. */
export function freshId(name: string, taken: readonly string[]): string {
  const base = slug(name, 'my-theme')
  const used = new Set([...taken, ...BUILTIN_THEME_IDS])
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const tail = `-${n}`
    const candidate = `${base.slice(0, 40 - tail.length)}${tail}`
    if (!used.has(candidate)) return candidate
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------------------------------------------
// Undo and redo

export type History = {
  present: Draft
  past: Draft[]
  future: Draft[]
  /** What was last saved (or loaded): Discard returns here, and "unsaved" is measured against it. */
  baseline: Draft
  /** Consecutive edits of one control (a colour being dragged) fold into one undo step. */
  last: { key: string; at: number } | null
}

const LIMIT = 100
const COALESCE_MS = 900

export function startHistory(draft: Draft): History {
  return { present: draft, past: [], future: [], baseline: draft, last: null }
}

export function edit(
  history: History,
  next: Draft,
  options: { key?: string; now?: number } = {},
): History {
  if (next === history.present || sameDraft(next, history.present)) return history
  const now = options.now ?? Date.now()
  const fold =
    options.key !== undefined &&
    history.last?.key === options.key &&
    now - history.last.at < COALESCE_MS &&
    history.past.length > 0
  const past = fold ? history.past : [...history.past, history.present].slice(-LIMIT)
  return {
    ...history,
    present: next,
    past,
    future: [],
    last: options.key !== undefined ? { key: options.key, at: now } : null,
  }
}

export function undo(history: History): History {
  const previous = history.past.at(-1)
  if (!previous) return history
  return {
    ...history,
    present: previous,
    past: history.past.slice(0, -1),
    future: [history.present, ...history.future],
    last: null,
  }
}

export function redo(history: History): History {
  const [next, ...rest] = history.future
  if (!next) return history
  return {
    ...history,
    present: next,
    past: [...history.past, history.present],
    future: rest,
    last: null,
  }
}

/** Back to the saved theme. It is an edit like any other, so Undo brings the changes back. */
export function discard(history: History): History {
  return edit(history, history.baseline)
}

/** The saved theme is now this draft (after Save): the history stays, so Undo still works. */
export function markSaved(history: History, saved: Draft = history.present): History {
  return { ...history, baseline: saved }
}

/**
 * A save finished. `submitted` is what was sent: that is what is saved now, whatever was typed while the request was
 * out. The draft on screen stays as it is (so those edits aren't lost and "Unsaved changes" stays on if it differs from
 * what was saved); only the address the theme now has (and, if nothing changed meanwhile, its stored form) is followed.
 */
export function afterSave(
  history: History,
  submitted: Draft,
  stored: ThemeManifest,
  /** The draft on screen when the request started; `submitted` differs from it by the name and id a copy was given. */
  before: Draft = submitted,
): History {
  const untouched = sameDraft(history.present, before)
  const typedName = history.present.manifest.name !== before.manifest.name
  const present: Draft = untouched
    ? { ...history.present, manifest: stored }
    : {
        ...history.present,
        // The address always follows; the name does unless it was edited while the request was out.
        manifest: {
          ...history.present.manifest,
          id: stored.id,
          ...(typedName ? {} : { name: stored.name }),
        },
      }
  const next = edit(history, present)
  return markSaved(next, { ...submitted, manifest: stored })
}

export const canUndo = (history: History) => history.past.length > 0
export const canRedo = (history: History) => history.future.length > 0
export const isDirty = (history: History) => !sameDraft(history.present, history.baseline)
