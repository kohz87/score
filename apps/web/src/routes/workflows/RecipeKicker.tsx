import type { ReactNode } from 'react'

export function Kicker({ children }: { children: ReactNode }) {
  return <span className="rl-kicker">{children}</span>
}
