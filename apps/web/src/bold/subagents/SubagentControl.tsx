import type { Job, JobSubagentsRequest } from '@score/contract'
import { useEffect, useId, useRef, useState } from 'react'
import { useAgentSubagents, useSetJobSubagents } from './subagent-queries.ts'
import { subagentControlLabel } from './subagent-model.ts'
import './subagents.css'

/**
 * SA.3: the context bar's "Subagents: up to 4" beside the model. It opens the same choices as `/subagents`: off, the
 * agent's own limit, or a lower number at once. A coding agent whose program can't be limited gets no button.
 */
export function SubagentControl({ job, agentId }: { job: Job; agentId: string }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const ceiling = useAgentSubagents(agentId, Boolean(job.subagents))
  const save = useSetJobSubagents(job.id)
  const limits = job.subagents

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!button.current?.parentElement?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      requestAnimationFrame(() => button.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  if (!limits || ceiling.data?.control === 'none') return null
  const max = ceiling.data?.maxConcurrent ?? limits.maxConcurrent ?? 1
  // Claude Code decides how many run at once, so a count can't be set for it: only off and its own choice.
  const counted = ceiling.data?.control !== 'on_off'
  const options: JobSubagentsRequest[] = [
    { enabled: false },
    ...(counted
      ? Array.from({ length: max }, (_, index) => ({ enabled: true, maxConcurrent: index + 1 }))
      : []),
    { enabled: true, maxConcurrent: null },
  ]

  function choose(body: JobSubagentsRequest) {
    setOpen(false)
    save.mutate(body)
  }

  const label = subagentControlLabel(job, ceiling.data)
  return (
    <span
      className="bold-subagents-control"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
        button.current?.focus()
      }}
    >
      <button
        ref={button}
        type="button"
        className="bold-subagents-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={save.isPending}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div className="bold-subagents-menu" id={menuId} role="menu" aria-label="Subagents">
          {options.map((option) => {
            const off = option.enabled === false
            const back = option.enabled === true && option.maxConcurrent === null
            const n = typeof option.maxConcurrent === 'number' ? option.maxConcurrent : null
            const checked = off
              ? !limits.enabled
              : back
                ? limits.enabled && limits.maxConcurrent === null
                : limits.enabled && limits.maxConcurrent === n
            return (
              <button
                key={off ? 'off' : back ? 'back' : String(n)}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => choose(option)}
              >
                {off ? 'Off' : back ? `Back to the agent’s limit (${max})` : `At most ${n} at once`}
                <small>
                  {off
                    ? 'None in this job'
                    : back
                      ? 'The agent’s own setting'
                      : n === 1
                        ? '1 at once in this job'
                        : `${n} at once in this job`}
                </small>
              </button>
            )
          })}
          {save.error && (
            <span className="bold-subagents-menu-error" role="alert">
              Couldn’t change subagents. Try again.
            </span>
          )}
        </div>
      )}
    </span>
  )
}
