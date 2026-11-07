import type { HermesCheck } from '@score/contract'
import { redact } from '../../redact.ts'

/** What `hermes update --check` printed: a channel tip ahead of the install, or nothing newer. */
export function parseCheck(lines: string[]): {
  available: boolean
  behind: number | null
  summary: string
} {
  const text = lines.map((line) => line.trim()).filter(Boolean)
  const behindLine = text.find((line) => /\b(\d[\d,]*)\s+commits?\s+behind\b/i.test(line))
  if (behindLine) {
    const behind = Number(
      behindLine.match(/\b(\d[\d,]*)\s+commits?\s+behind\b/i)![1]!.replace(/,/g, ''),
    )
    return { available: behind > 0, behind, summary: clean(behindLine) }
  }
  const newer = text.find((line) => /update available|newer release available/i.test(line))
  if (newer) return { available: true, behind: null, summary: clean(newer) }
  const answer =
    text.find((line) => /no newer|up to date|already/i.test(line)) ??
    text.at(-1) ??
    'No answer from Hermes.'
  return { available: false, behind: null, summary: clean(answer) }
}

/** The services `hermes update --plan` says it restarts ("gateway [default]"). */
export function parsePlan(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => /^[•*-]\s+\S/.test(line))
    .map((line) => clean(line.replace(/^[•*-]\s+/, '').replace(/\s+pid\s+\d+.*$/, '')))
    .filter(Boolean)
    .slice(0, 10)
}

export function clean(line: string): string {
  // Hermes decorates its lines with symbols; the words are what the person reads.
  return redact(line.replace(/^[^\p{L}\p{N}]+/u, '').trim()).slice(0, 300)
}

export function unreadable(check: HermesCheck): boolean {
  return check.parts.some((part) => /could not be read/i.test(part.detail))
}

export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
