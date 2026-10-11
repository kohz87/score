import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeVisual } from './orch-model.ts'

const playMotion = vi.hoisted(() => vi.fn(() => () => {}))
vi.mock('../../motion/motion.ts', async (original) => ({
  ...(await original<typeof import('../../motion/motion.ts')>()),
  playMotion,
  loadAnime: () => new Promise(() => {}),
}))

import { LiveDiagram } from './LiveDiagram.tsx'

const nodes = [
  { id: 'lead', kind: 'lead' as const, agentId: 'lead', label: 'Lead' },
  { id: 's1', kind: 'step' as const, agentId: 'builder', label: 's1' },
]
const edges = [{ id: 'lead>s1', from: 'lead', to: 's1', kind: 'assign' as const }]

function diagram(state: NodeVisual, reducedMotion = false) {
  return (
    <LiveDiagram
      nodes={nodes}
      edges={edges as never}
      visuals={new Map([['s1', state]])}
      lead="working"
      agents={[]}
      selected={null}
      onSelect={() => {}}
      active={[]}
      reducedMotion={reducedMotion}
    />
  )
}

beforeEach(() => playMotion.mockClear())

describe('node transitions', () => {
  it('do not animate on the first render, nor when nothing changes', () => {
    const view = render(diagram('running'))
    view.rerender(diagram('running'))
    expect(playMotion).not.toHaveBeenCalled()
  })

  it('animate once when a node changes state', () => {
    const view = render(diagram('running'))
    view.rerender(diagram('succeeded'))
    expect(playMotion).toHaveBeenCalledTimes(1)
  })

  it('stay silent when the diagram is quiet (reduced motion, fast replay)', () => {
    const view = render(diagram('running', true))
    view.rerender(diagram('succeeded', true))
    expect(playMotion).not.toHaveBeenCalled()
  })
})
