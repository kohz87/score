import { expect, test } from 'vitest'
import { renderMarkdown } from '../src/shares/markdown.ts'

test('deeply nested quotes render without exhausting the stack, excess markers as escaped text', () => {
  const html = renderMarkdown('>'.repeat(5000) + ' hello')
  expect(html).toContain('hello')
  expect(html).toContain('&gt;')
  expect(html.match(/<blockquote>/g)!.length).toBeLessThanOrEqual(8)
})
