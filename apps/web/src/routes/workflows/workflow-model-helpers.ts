import type { Draft } from './workflow-model-types.ts'

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The draft is the same graph, text and settings as `saved` (what Save would change nothing about). */
export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A value by a name people chose: own entries only, so `constructor` reads as empty, not as a function (S2-010). */
export function ownText(values: Readonly<Record<string, string>>, name: string): string {
  return Object.hasOwn(values, name) ? (values[name] ?? '') : ''
}
