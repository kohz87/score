import type { ReactNode } from 'react'

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="jobmap-pill" data-tone={tone}>
      {children}
    </span>
  )
}
