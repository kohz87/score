import type { AgentDetail } from '@score/contract'
import { useEffect, useRef } from 'react'
import { LooksCard } from '../agent-more/LooksCard.tsx'
import { NameCard } from '../agent-more/NameCard.tsx'

/** The header's Edit: name, role and look, the two cards that used to sit under More, side by side under the header. */
export function AgentEditPanel({
  agent,
  editable,
  onClose,
}: {
  agent: AgentDetail
  editable: boolean
  onClose: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  // Opening moves focus into the panel; closing (here or with Edit) returns it to Edit.
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    return () => {
      window.setTimeout(
        () => document.querySelector<HTMLElement>('.bold-agent-edit-btn')?.focus(),
        0,
      )
    }
  }, [])
  return (
    <section ref={panel} className="bold-agent-edit" aria-label="Edit name, role and look">
      <div className="bold-agent-edit-grid">
        {editable && <NameCard agent={agent} />}
        <LooksCard agent={agent} />
      </div>
      <button type="button" className="btn sm ghost" onClick={onClose}>
        Close
      </button>
    </section>
  )
}
