import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubReducedMotion } from '../../motion/test-support.ts'
import { CountUp } from './CountUp.tsx'

beforeEach(() => stubReducedMotion(false))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CountUp', () => {
  it('counts up from zero to the figure, keeping prefix, suffix and decimals', async () => {
    render(<CountUp text="$1.50" />)
    expect(screen.getByText('$0.00')).toBeTruthy()
    await waitFor(
      () => {
        expect(screen.getByText('$1.50')).toBeTruthy()
        // The page says it is settled once the count has landed.
        expect(document.documentElement.dataset.motion).toBeUndefined()
      },
      { timeout: 3000 },
    )
  })

  it('shows the figure at once with reduced motion', () => {
    stubReducedMotion(true)
    render(<CountUp text="85%" />)
    expect(screen.getByText('85%')).toBeTruthy()
  })

  it('leaves figures that are not plain numbers alone', () => {
    render(<CountUp text="—" />)
    expect(screen.getByText('—')).toBeTruthy()
    render(<CountUp text="1,234" />)
    expect(screen.getByText('1,234')).toBeTruthy()
  })
})
