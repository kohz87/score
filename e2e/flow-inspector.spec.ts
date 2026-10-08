import { expect, test } from '@playwright/test'
import { flowFixture } from './flow-fixture.ts'
import { fixtureNow } from './now-fixture.ts'
import { pair } from './pair.ts'

test.use({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', locale: 'en-GB' })

test('Flow inspector, log and stats match the design with fixed neutral data', async ({ page }) => {
  await pair(page)
  const fixture = flowFixture('room-fixture')
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/stream*', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: '' }),
  )
  await page.route('**/api/now', (route) => route.fulfill({ json: fixture.score }))
  await page.route('**/api/agents', (route) =>
    route.fulfill({ json: { asOfSeq: 1, items: fixture.agents } }),
  )
  await page.route('**/api/briefs?*', (route) =>
    route.fulfill({
      json: { items: route.request().url().endsWith('active') ? [fixture.flow.brief] : [] },
    }),
  )
  await page.route('**/api/briefs/fixture-flow/flow', (route) =>
    route.fulfill({ json: fixture.flow }),
  )
  await page.route('**/api/flow/nodes/*', (route) => route.fulfill({ json: fixture.detail }))
  await page.route('**/api/approvals?*', (route) =>
    route.fulfill({ json: { asOfSeq: 1, items: [fixture.detail.approval], nextCursor: null } }),
  )
  await page.route('**/api/briefs/fixture-flow/log?*', (route) => {
    const params = new URL(route.request().url()).searchParams
    return route.fulfill({
      json: {
        items: fixture.log.items.filter(
          (line) =>
            (!params.has('agent') || line.agentId === params.get('agent')) &&
            (params.get('kind') !== 'tool' || line.kind === 'tool'),
        ),
        nextCursor: null,
      },
    })
  })
  await page.goto('/now/flow/fixture-flow')
  const inspector = page.getByRole('complementary', { name: 'Selected step' })
  await expect(inspector.getByRole('heading', { name: 'Event stream' })).toBeVisible()
  await expect(inspector.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(inspector.getByText('Waiting on you for 1 min')).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'This run so far' }).getByText('$1.84'),
  ).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('.flow-view')).toHaveScreenshot('now-flow.png', {
    maxDiffPixelRatio: 0.01,
  })
  const log = page.getByRole('region', { name: 'Live log' })
  await log.getByRole('button', { name: 'Tool calls' }).click()
  await expect(log.getByText('Ran cursor tests, all passing')).toBeVisible()
  await expect(log.getByText('Reading api/events.py')).toHaveCount(0)
  await log.getByRole('button', { name: 'reviewer' }).click()
  await expect(log.getByText('Reading api/events.py')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(inspector.getByRole('button', { name: 'Stop this step' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('a paired human can stop a live fake step from its inspector', async ({ page }) => {
  await pair(page)
  const ids = await page.evaluate(async () => {
    const post = async (path: string, body: object) => {
      const response = await fetch(`/api/${path}`, {
        method: 'POST',
        headers: {
          'X-Score-Client': 'web',
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      })
      return response.json() as Promise<Record<string, unknown>>
    }
    const room = await post('rooms', { name: `flow-stop-${Date.now()}`, leadAgentId: 'builder' })
    const sent = await post(`rooms/${String(room.id)}/messages`, {
      text: 'Ask for approval before installing the package',
    })
    return { roomId: String(room.id), briefId: (sent.message as { id: string }).id }
  })
  await page.goto(`/now/flow/${ids.briefId}`)
  const inspector = page.getByRole('complementary', { name: 'Selected step' })
  await expect(inspector.getByRole('button', { name: 'Stop this step' })).toBeEnabled({
    timeout: 20_000,
  })
  await inspector.getByRole('button', { name: 'Stop this step' }).click()
  await expect(inspector.getByRole('button', { name: 'Stopped' })).toBeVisible()
  await expect
    .poll(async () => {
      const flow = (await (await page.request.get(`/api/briefs/${ids.briefId}/flow`)).json()) as {
        nodes: { id: string; state: string }[]
      }
      const node = flow.nodes.find((item) => item.id.startsWith('turn:'))!
      const detail = (await (
        await page.request.get(`/api/flow/nodes/${encodeURIComponent(node.id)}`)
      ).json()) as { run: { status: string } }
      return detail.run.status
    })
    .toBe('cancelled')
})
