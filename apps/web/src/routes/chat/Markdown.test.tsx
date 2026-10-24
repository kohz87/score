import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { tokenize } from './highlight.ts'
import { Markdown } from './Markdown.tsx'

afterEach(cleanup)

test('renders headings, lists, tables, inline code and quotes', () => {
  const { container } = render(
    <Markdown
      text={
        '# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\nuse `pnpm test`'
      }
    />,
  )
  expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
  expect(container.querySelectorAll('li')).toHaveLength(2)
  expect(screen.getByRole('table')).toBeTruthy()
  expect(container.querySelector('blockquote')?.textContent).toContain('quoted')
  expect(container.querySelector('p code')?.textContent).toBe('pnpm test')
})

test('links open in a new tab without opener access', () => {
  render(<Markdown text="see [docs](https://example.com/a)" />)
  const link = screen.getByRole('link', { name: 'docs' })
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})

test('raw HTML, scripts, javascript: links and images stay inert', () => {
  const { container } = render(
    <Markdown
      text={
        '<script>window.hacked = 1</script>\n\n<img src=x onerror="window.hacked=1">\n\n[bad](javascript:alert(1))\n\n![tracker](https://evil.example/p.png)\n\n<b>bold?</b>'
      }
    />,
  )
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('b')).toBeNull()
  expect((globalThis as { hacked?: number }).hacked).toBeUndefined()
  const bad = container.querySelector('a')
  expect(bad?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  expect(container.textContent).toContain('tracker')
})

test('a fenced block shows its language, highlights and copies', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const { container } = render(<Markdown text={'```ts\nconst size = 25 // page\n```'} />)
  expect(screen.getByText('ts')).toBeTruthy()
  expect(container.querySelector('.tok-keyword')?.textContent).toBe('const')
  expect(container.querySelector('.tok-number')?.textContent).toBe('25')
  expect(container.querySelector('.tok-comment')?.textContent).toBe('// page')
  fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('const size = 25 // page'))
  expect(await screen.findByText('Copied', { selector: 'button' })).toBeTruthy()
})

test('a mermaid block keeps its source under a Mermaid diagram label', () => {
  const { container } = render(<Markdown text={'```mermaid\ngraph TD; A-->B\n```'} />)
  expect(screen.getByText('Mermaid diagram')).toBeTruthy()
  expect(container.querySelector('pre')?.textContent).toBe('graph TD; A-->B')
})

test('tokenizer: unknown languages are plain and an unclosed quote does not swallow later lines', () => {
  expect(tokenize('x = 1', 'brainfuck')).toEqual([{ text: 'x = 1', type: 'plain' }])
  const tokens = tokenize("it's\nreturn 1", 'js')
  expect(tokens.some((token) => token.type === 'keyword' && token.text === 'return')).toBe(true)
  expect(
    tokenize('SELECT * FROM t', 'sql').filter((token) => token.type === 'keyword'),
  ).toHaveLength(2)
})

test("workspace:// links open the file in the author agent's Workspace tab, not in a new tab", () => {
  render(
    <MemoryRouter>
      <Markdown
        text="see [main](workspace://src/main.ts) and [theirs](workspace://reviewer/a.md)"
        workspace={{ agentId: 'builder', agentIds: ['builder', 'reviewer'] }}
      />
    </MemoryRouter>,
  )
  const main = screen.getByRole('link', { name: 'main' })
  expect(main.getAttribute('href')).toBe('/team/builder/workspace?path=src%2Fmain.ts')
  expect(main.getAttribute('target')).toBeNull()
  expect(screen.getByRole('link', { name: 'theirs' }).getAttribute('href')).toBe(
    '/team/reviewer/workspace?path=a.md',
  )
})

test('a workspace:// link with no known agent is plain text; other schemes stay blocked', () => {
  render(<Markdown text="[x](workspace://a.md) [y](javascript:alert(1))" />)
  expect(screen.queryByRole('link', { name: 'x' })).toBeNull()
  expect(screen.getByText('x')).toBeTruthy()
  expect(screen.getByText('y').getAttribute('href')).toBeFalsy()
})

test('a bold room can resolve a workspace link through a job before rendering it', () => {
  render(
    <MemoryRouter>
      <Markdown
        text="[feed](workspace://api/events.py)"
        workspace={{
          agentId: 'builder',
          agentIds: ['builder'],
          linkFor: (target) =>
            `/b?job=job-feed&work=code&file=${encodeURIComponent(target.path)}`,
        }}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'feed' }).getAttribute('href')).toBe(
    '/b?job=job-feed&work=code&file=api%2Fevents.py',
  )
})

test('a reply written with • bullets shows as a nested list, not one paragraph', () => {
  const { container } = render(
    <Markdown
      text={
        'Minutes:\n• Lock the tiles.\n• Clarify Rift:\n  • 3 of each.\n  • About 3 cards.\n• Resolve the counter.'
      }
    />,
  )
  const top = container.querySelector('.chat-md > ul')
  expect(top?.children.length).toBe(3)
  expect(top?.querySelectorAll(':scope > li > ul > li').length).toBe(2)
  expect(container.querySelector('p')?.textContent).toBe('Minutes:')
})
