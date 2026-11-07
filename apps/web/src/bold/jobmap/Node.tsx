import type { ReactNode } from 'react'
import type { LayerId } from './job-map-model.ts'

export function Node({
  layer,
  selected,
  onPick,
  label,
  tone,
  pulse,
  children,
  className,
}: {
  layer: LayerId
  selected: LayerId | null
  onPick: (layer: LayerId) => void
  label: string
  tone: string
  pulse?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      className={`jobmap-node ${className ?? ''}`}
      data-layer={layer}
      data-tone={tone}
      data-pulse={pulse ? '' : undefined}
      aria-label={label}
      aria-pressed={selected === layer}
      onClick={() => onPick(layer)}
    >
      {children}
    </button>
  )
}
