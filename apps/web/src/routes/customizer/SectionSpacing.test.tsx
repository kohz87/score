import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { emptyManifest, type Draft } from '../../themes/customizer/draft.ts'
import { SectionShape } from './SectionShape.tsx'
import { SectionSpacing } from './SectionSpacing.tsx'
import type { SectionContext } from './section-context.ts'

afterEach(cleanup)

const draft = (): Draft => ({ manifest: emptyManifest('x', 'X'), css: '', uploads: {} })
const context = (edit: SectionContext['edit']): SectionContext => ({
  draft: draft(),
  edit,
  mode: 'dark',
  setMode: () => {},
  defaults: () => '',
  problems: [],
  resolve: () => null,
  announce: () => {},
  report: { dropped: [] },
})

test('Spacing offers density and corners, and none of the classic menu options', () => {
  const edit = vi.fn()
  render(<SectionSpacing {...context(edit)} />)
  expect(screen.getByRole('radiogroup', { name: 'Spacing' })).toBeTruthy()
  expect(screen.getByRole('radiogroup', { name: 'Corners' })).toBeTruthy()
  expect(screen.queryByText('Left rail')).toBeNull()
  expect(screen.queryByText('Menu')).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'Airy' }))
  const next = edit.mock.calls[0]![0] as Draft
  expect(next.manifest.shape?.density).toBe('airy')
})

test('Shape keeps borders, shadows and the card surface', () => {
  render(<SectionShape {...context(vi.fn())} />)
  for (const name of ['Borders', 'Shadows', 'Card surface'])
    expect(screen.getByRole('radiogroup', { name })).toBeTruthy()
  expect(screen.queryByRole('radiogroup', { name: 'Corners' })).toBeNull()
})
