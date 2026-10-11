import type { Approval, ApprovalChoice } from '@score/contract'

// PLAN 5.39: a decision does not vanish. It becomes a compact chip where the question was.

export type ChipTone = 'ok' | 'no' | 'neutral'
export type Chip = { tone: ChipTone; text: string; at: string | null }

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** What you chose, as the chip says it. */
export const YOUR_CHOICE: Record<ApprovalChoice, string> = {
  once: 'Approved by you',
  session: 'Approved for this session',
  always: 'Always allowed',
  deny: 'Rejected',
}

const toneOf = (choice: ApprovalChoice): ChipTone => (choice === 'deny' ? 'no' : 'ok')

/** The chip of an approval that has an outcome, or null while it is still open (or being delivered). */
export function approvalChip(approval: Approval): Chip | null {
  const { decision } = approval
  if (approval.delivery === 'not_pending')
    return { tone: 'neutral', text: 'Answered elsewhere', at: decision?.at ?? null }
  if (approval.delivery === 'unknown')
    return { tone: 'neutral', text: 'May have been answered', at: decision?.at ?? null }
  if (approval.delivery === 'intent' || approval.delivery === 'delivering') return null
  if (decision) {
    const verb = decision.choice === 'deny' ? 'denied' : 'approved'
    const text =
      decision.by === 'you'
        ? YOUR_CHOICE[decision.choice]
        : decision.by === 'guardian'
          ? `Guardian ${verb} this`
          : decision.by === 'rule'
            ? `A rule ${verb} this`
            : decision.by === 'timeout'
              ? 'Timed out'
              : `Answered elsewhere (${verb})`
    return {
      tone: decision.by === 'timeout' ? 'neutral' : toneOf(decision.choice),
      text,
      at: decision.at,
    }
  }
  if (approval.status === 'expired') return { tone: 'neutral', text: 'Expired', at: null }
  if (approval.status === 'withdrawn') return { tone: 'neutral', text: 'Withdrawn', at: null }
  if (approval.status === 'unknown')
    return { tone: 'neutral', text: 'May have been answered', at: null }
  return null
}

/** Plain text of a chip, with the time: "Approved by you · 14:02". */
export function chipText(chip: Chip): string {
  return chip.at ? `${chip.text} · ${clock(chip.at)}` : chip.text
}
