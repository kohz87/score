import type { TriggerMapping } from '@score/contract'

export type MappingSlot = 'ref' | 'title' | 'link' | 'details'

export const MAPPING_SLOTS: readonly { key: MappingSlot; label: string; hint: string }[] = [
  { key: 'ref', label: 'Reference', hint: 'Required. Ties the job to the item.' },
  { key: 'title', label: 'Title', hint: 'Names the job.' },
  { key: 'link', label: 'Link', hint: 'Open the item in the app.' },
  { key: 'details', label: 'Details', hint: 'Given to agents as quoted outside text.' },
]

export type PayloadLeaf = { path: string; value: unknown }

const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/

/** Every value a JSON path can name, in the order the app sent them. */
export function flattenPayload(
  value: unknown,
  prefix = '',
  out: PayloadLeaf[] = [],
): PayloadLeaf[] {
  if (out.length >= 300) return out
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (!PATH.test(path)) continue
      if (child !== null && typeof child === 'object') flattenPayload(child, path, out)
      else out.push({ path, value: child })
      if (out.length >= 300) break
    }
    return out
  }
  if (prefix && PATH.test(prefix)) out.push({ path: prefix, value })
  return out
}

/** A value at a dot path, using own keys only (the same rule the server follows). */
export function valueAtPath(payload: unknown, path: string): unknown {
  let at: unknown = payload
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

export function cleanMapping(mapping: Record<MappingSlot, string>): TriggerMapping {
  return {
    ref: mapping.ref,
    ...(mapping.title ? { title: mapping.title } : {}),
    ...(mapping.link ? { link: mapping.link } : {}),
    ...(mapping.details ? { details: mapping.details } : {}),
  }
}

/** The prototype's guess from field names; the person still sees and can change every slot. */
export function guessMapping(sample: unknown): Record<MappingSlot, string> {
  const leaves = flattenPayload(sample)
  const find = (pattern: RegExp) =>
    leaves.find((leaf) => pattern.test(leaf.path.split('.').at(-1) ?? ''))?.path ?? ''
  return {
    ref: find(/^(id|number|key|ref)$/i),
    title: find(/^(title|subject|name|summary)$/i),
    link: find(/^(url|link|html_url)$/i),
    details: find(/^(body|description|text|details)$/i),
  }
}

/** A readable preview of what a job would say, without sending anything. */
export function renderTemplate(template: string, sample: unknown): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path: string) => {
    const value = valueAtPath(sample, path)
    if (value === undefined) return `(no ${path})`
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}
