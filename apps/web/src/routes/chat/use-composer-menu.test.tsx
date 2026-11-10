import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, jsonResponse } from '../../bold/room/room-test-utils.tsx'
import type { TopicCommands } from './composer-types.ts'
import { useComposerMenu } from './use-composer-menu.ts'

afterEach(() => vi.unstubAllGlobals())

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
)

/** The effort palette for the addressed agent, as a bold room offers it (its levels are read). */
const bold = (levels: boolean): TopicCommands => ({
  items: [],
  typedOnly: ['effort'],
  menuFor: () =>
    levels
      ? [{ name: 'effort', usage: '/effort high', insert: '/effort high', description: 'High' }]
      : [],
  run: async () => undefined,
})

function menuFor(text: string, caret: number, topicCommands?: TopicCommands) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ items: [] })),
  )
  const { result } = renderHook(
    () =>
      useComposerMenu({
        text,
        caret,
        offered: agents,
        addressee: null,
        topicCommands,
        ids: 'composer',
        textarea: { current: null },
        setText: () => undefined,
        setCaret: () => undefined,
      }),
    { wrapper },
  )
  return result.current
}

test('with no effort menu (the classic view), a mention in an @agent /effort line still completes', () => {
  const state = menuFor('@bui /effort', 4)
  expect(state.menu).toBe('mention')
  expect(state.mentionItems.map((agent) => agent.id)).toContain('builder')
})

test('where the effort menu has items, @agent /eff offers its choices and suppresses mention completion', () => {
  const state = menuFor('@builder /effort', 8, bold(true))
  expect(state.menu).toBe('slash')
  expect(state.slashItems.map((item) => item.usage)).toEqual(['/effort high'])
  expect(state.mentionItems).toEqual([])
})

test('before the levels have loaded, the same line keeps mention completion', () => {
  const state = menuFor('@bui /effort', 4, bold(false))
  expect(state.menu).toBe('mention')
})
