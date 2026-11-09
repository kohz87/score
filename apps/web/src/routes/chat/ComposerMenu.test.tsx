import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ComposerMenu } from './ComposerMenu.tsx'
import type { SlashCommand } from './composer-model.ts'

/** The slash palette shows a note only for the command that is selected. */
const command = (name: string, note?: string): SlashCommand => ({
  name,
  usage: `/${name}`,
  description: `${name} description`,
  note,
})

const items = [command('subagents', 'Subagents note'), command('usage', 'Usage note')]

test('the note under the slash palette is the selected command’s, only', () => {
  const props = {
    menu: 'slash' as const,
    count: items.length,
    slashItems: items,
    mentionItems: [],
    ids: 'composer',
    optionId: (position: number) => `option-${position}`,
    select: () => undefined,
  }
  const { rerender } = render(<ComposerMenu {...props} index={0} />)
  expect(screen.getByText('Subagents note')).toBeTruthy()
  expect(screen.queryByText('Usage note')).toBeNull()
  rerender(<ComposerMenu {...props} index={1} />)
  expect(screen.getByText('Usage note')).toBeTruthy()
  expect(screen.queryByText('Subagents note')).toBeNull()
})
