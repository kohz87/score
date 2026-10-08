import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('a run that asks for approval shows a card in the room and approving it resolves the ledger', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /#activity-feed/ })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  await expect(history.getByRole('article').first()).toBeVisible({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await expect(composer).toBeEnabled()

  const prompt = `Please ask for approval before installing ${Date.now()}`
  await composer.fill(prompt)
  await composer.press('Enter')
  const card = history.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 20_000 })
  await expect(card.locator('code')).toHaveText('pnpm add ws@8.18.0')
  const id = await page.evaluate(async () => {
    const response = await fetch('/api/approvals')
    const { items } = (await response.json()) as { items: { id: string }[] }
    return items.find((item) => item.id.startsWith('fake-approval:'))?.id
  })
  expect(id).toBeTruthy()

  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(card.getByText('You approved')).toBeVisible({ timeout: 15_000 })

  const ledger = await page.evaluate(async () => {
    const response = await fetch('/api/approvals?status=all')
    return (await response.json()) as {
      items: { id: string; status: string; decision: { by: string; choice: string } | null }[]
    }
  })
  const decided = ledger.items.find((item) => item.id === id)
  expect(decided?.status).toBe('approved')
  expect(decided?.decision).toMatchObject({ by: 'you', choice: 'once' })
})
