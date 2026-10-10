import { ancestorsOf, type Draft } from './workflow-model.ts'

// Autocomplete for the `{{inputs.x}}` / `{{nodes.N.output|verdict}}` references of an instruction or a gate question
// (contract §15 "Definitions"). Plain substitution, no expressions; references may only read from ancestors of the node.

export interface TemplateOption {
  /** What is written into the text, braces included. */
  insert: string
  /** Short label in the list: `inputs.topic`, `nodes.draft.output`. */
  label: string
  /** One plain sentence about it. */
  detail: string
}

export interface OpenReference {
  /** Index of the `{{` that is still open. */
  start: number
  /** Where the replaced range ends: the caret, or after a `}}` that was already typed. */
  end: number
  /** What was typed after `{{`, trimmed at the left. */
  query: string
}

/** The `{{` the caret is inside of (no `}}` between it and the caret), or null. */
export function openReference(text: string, caret: number): OpenReference | null {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf('{{')
  if (start === -1) return null
  const typed = before.slice(start + 2)
  if (typed.includes('}}') || typed.includes('\n')) return null
  const after = text.slice(caret)
  const end = after.startsWith('}}') ? caret + 2 : caret
  return { start, end, query: typed.trimStart() }
}

export function templateOptions(draft: Draft, nodeId: string | null): TemplateOption[] {
  const options: TemplateOption[] = draft.inputs.map((input) => ({
    insert: `{{inputs.${input.name}}}`,
    label: `inputs.${input.name}`,
    detail: `What you type for "${input.label}" when you start the run`,
  }))
  const before = nodeId ? ancestorsOf(draft, nodeId) : new Set<string>()
  for (const node of draft.nodes) {
    if (node.kind !== 'agent' || !before.has(node.id)) continue
    options.push(
      {
        insert: `{{nodes.${node.id}.output}}`,
        label: `nodes.${node.id}.output`,
        detail: `What "${node.label}" replied`,
      },
      {
        insert: `{{nodes.${node.id}.verdict}}`,
        label: `nodes.${node.id}.verdict`,
        detail: `"passed" or "changes_requested", if "${node.label}" gave a verdict`,
      },
    )
  }
  return options
}

/** The options that match what was typed after `{{`; an empty query matches everything. */
export function suggest(draft: Draft, nodeId: string | null, query: string): TemplateOption[] {
  const needle = query.trim().toLowerCase()
  return templateOptions(draft, nodeId).filter((option) =>
    needle === '' ? true : option.label.toLowerCase().includes(needle),
  )
}

/** Writes `option` over the open reference; returns the new text and where the caret goes. */
export function applyOption(
  text: string,
  open: OpenReference,
  option: TemplateOption,
): { text: string; caret: number } {
  const next = text.slice(0, open.start) + option.insert + text.slice(open.end)
  return { text: next, caret: open.start + option.insert.length }
}
