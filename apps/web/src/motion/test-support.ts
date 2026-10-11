import { vi } from 'vitest'

/** Tests that read the final state of a screen switch motion off, as a person with reduced motion would. */
export function stubReducedMotion(reduce = true) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
}
