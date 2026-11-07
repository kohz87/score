import { expect, test } from '@playwright/test'
import { mockThemes } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { sheetsText } from './themes-decision.ts'

test.describe('the sanitiser in a real browser', () => {
  test('resolves CSS escapes before it checks, and reports what it dropped', async ({ page }) => {
    const css = [
      '@import url("https://evil.test/a.css");',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@page { margin: 0 }',
      '.a::after { \\63 ontent: "Approve"; }',
      '.b { background: url(https://evil.test/x.png); }',
      '.c { background: image-set("https://evil.test/x.png" 1x); }',
      '.d { \\70 osition: fixed; }',
      '.e { z-index: 99999; -webkit-user-modify: read-write; \\70ointer-events: none; }',
      '.f { color: red \\21 important; }',
      '.g { color: blue !\\69mportant; }',
      '\\5b data-protected\\5d { color: red; }',
      '.card:has(\\2e chat-approval) { color: red; }',
      '.card:has(\\2e bold-request) { color: red; }',
      '.keep { color: green; margin: 4px; }',
      '@font-face { font-family: Evil; src: url(asset:fonts/e.woff2); }',
    ].join('\n')
    await mockThemes(page, [{ id: 'escaped', name: 'Escaped', manifest: {}, css }], {
      active: 'escaped',
      mode: 'light',
    })
    await pair(page)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const sheets = await sheetsText(page)
    expect(sheets).toContain('.keep')
    expect(sheets).toContain('color: green')
    for (const gone of [
      'import',
      'namespace',
      'content',
      'evil.test',
      'fixed',
      '99999',
      'user-modify',
      'pointer-events',
      'important',
      'data-protected',
      'chat-approval',
      'bold-request',
      'font-face',
      '@page',
    ])
      expect(sheets, gone).not.toContain(gone)
  })
})
