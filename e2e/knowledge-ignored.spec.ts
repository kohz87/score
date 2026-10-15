import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Fake mode serves a throwaway vault under TMPDIR; a .gitignore rule there makes one folder "not kept in history".
test.beforeEach(async ({ page }) => {
  await pair(page)
})

test('a note in a Git-ignored folder is saved and marked as not kept in history', async ({
  page,
}) => {
  const folder = `nohistory-${Date.now().toString(36)}`
  for (const name of readdirSync(tmpdir()))
    if (name.startsWith('score-fake-vault-'))
      writeFileSync(join(tmpdir(), name, '.gitignore'), `${folder}/\n`, { flag: 'a' })

  await page.goto('/knowledge')
  await page.getByRole('button', { name: 'New note' }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await dialog.getByLabel('Path in Knowledge').fill(`${folder}/private-note`)
  await dialog.getByRole('button', { name: 'Create note' }).click()
  const path = `${folder}/private-note.md`
  const editor = page.getByLabel(`Contents of ${path}`)
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText('# Private note\n\nKept on disk only.\n')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByTestId('not-in-history')).toHaveText('Not kept in history')
  await expect(page.getByTestId('history-not-kept')).toContainText(
    '.gitignore excludes this folder',
  )
  await expect(page.getByTestId('history-missed')).toHaveCount(0)

  const shot = process.env.SCORE_AUDIT_SHOT
  if (shot) {
    mkdirSync(dirname(shot), { recursive: true })
    await page.screenshot({ path: shot })
  }
})
