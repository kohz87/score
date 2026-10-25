import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockThemes, type MockTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { samplePng } from './png.ts'
import { makeRoom, say } from './rooms.ts'
import { layoutThemes as t, openWithTheme, theme } from './themes-layout-fixtures.ts'

// The layout model (PLAN 9.3, design docs/briefs/9-themes.md § 7): every layout, shape and background option of a
// theme manifest changes the real app. Frozen fixture data, mocked theme routes (contract § 16); the default look's
// own baselines are in visual.spec.ts and stay untouched.

test.use({ timezoneId: 'UTC', locale: 'en-GB', viewport: { width: 1440, height: 1000 } })

async function open(
  page: Page,
  theme: MockTheme | null,
  path = '/chat/room-activity-feed',
  mode: 'light' | 'dark' = 'light',
) {
  await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
  await openWithTheme(page, theme ? [theme] : [], { active: theme?.id ?? 'score', mode })
  await page.goto(path)
  if (theme) await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  else await expect(page.locator('html')).toHaveAttribute('data-pack', 'score')
  await expect(page.getByRole('main')).toBeVisible()
}

const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox()
  expect(rect, selector).not.toBeNull()
  return rect!
}
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property)

test.describe('navigation', () => {
  test('top is Score’s own bar, left and right are rails on either side of the page', async ({
    page,
  }) => {
    await open(page, t.navTop)
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav).toBeVisible()
    const top = await nav.boundingBox()
    expect(top!.y).toBeLessThan(80)
    expect((await box(page, 'main')).y).toBeGreaterThan(top!.y + 40)
  })

  for (const [name, theme] of [
    ['left', t.navLeft],
    ['right', t.navRight],
  ] as const) {
    test(`${name} rail`, async ({ page }) => {
      await open(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-nav', name)
      const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox()
      const main = await box(page, 'main')
      // A column of links beside the page, from the top of the window.
      expect(nav!.height).toBeGreaterThan(150)
      if (name === 'left') expect(nav!.x + nav!.width).toBeLessThanOrEqual(main.x + 1)
      else expect(nav!.x).toBeGreaterThanOrEqual(main.x + main.width - 1)
      // Same links, same order, same keyboard path: Tab reaches Chat first.
      const labels = await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link')
        .allInnerTexts()
      expect(labels.map((label) => label.trim())).toEqual([
        'Chat',
        'Team',
        'Knowledge',
        'Reports',
        'Settings',
      ])
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1)
    })
  }

  test('launcher: one menu button opens the drawer, ⌘K stays, the Needs-you dot rides on the button', async ({
    page,
  }) => {
    await open(page, t.navLauncher)
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    const button = page.getByRole('button', { name: 'Menu' })
    await expect(button).toBeVisible()
    const rect = await button.boundingBox()
    expect(rect!.x).toBeLessThan(60)
    await expect(page.getByRole('img', { name: 'Needs you' })).toBeVisible()
    // The page gets the whole width.
    expect((await box(page, 'main')).width).toBeGreaterThan(1300)
    await button.click()
    const drawer = page.getByRole('dialog', { name: 'Menu' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Chat' })).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible()
    // The dot is on the first destination inside the drawer (and not twice on the page).
    await expect(
      drawer.getByRole('link', { name: /^Chat/ }).getByRole('img', { name: 'Needs you' }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(button).toBeFocused()
    await drawer.waitFor({ state: 'detached' })
    await button.click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Chat' }).click()
    await expect(page).toHaveURL(/\/chat/)
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog', { name: 'Search or run a command' })).toBeVisible()
  })

  for (const [name, theme] of [
    ['left', t.navLeft],
    ['right', t.navRight],
    ['launcher', t.navLauncher],
  ] as const) {
    test(`on a phone the ${name} navigation is Score’s top bar and drawer`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await open(page, theme)
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
      await page.getByRole('button', { name: 'Menu' }).click()
      const drawer = page.getByRole('dialog', { name: 'Menu' })
      await expect(drawer.getByRole('link', { name: 'Knowledge' })).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1)
    })
  }

  test('resetting the look with the launcher drawer open leaves nothing inert or scroll-locked', async ({
    page,
  }) => {
    await open(page, t.navLauncher)
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
    await expect(page.locator('.shell-content')).toHaveAttribute('inert', '')
    await page.keyboard.press('Control+Shift+Digit0')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
    await expect(page.locator('.shell-content')).not.toHaveAttribute('inert', '')
    // The lock is released by the drawer's effect cleanup, a moment after the commit that removes `inert`: wait for it
    // rather than sampling once (the product does end up unlocked; this only checks that it does).
    await expect
      .poll(() => page.evaluate(() => document.body.classList.contains('scroll-locked')))
      .toBe(false)
    // The page works again: Score's own top bar, and a click lands.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chat' }).click()
    await expect(page).toHaveURL(/\/chat/)
  })

  for (const width of [1440, 1100]) {
    test(`five 24-character labels keep Settings and the controls on screen at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      // The widest letters, 24 of them: Chat, Team, ... each padded with W.
      const labels = ['Chat', 'Team', 'Knowledge', 'Reports', 'Settings'].map((name) =>
        (name + 'W'.repeat(24)).slice(0, 24),
      )
      expect(labels.every((label) => label.length === 24)).toBe(true)
      const paths = ['/chat', '/team', '/knowledge', '/reports', '/settings']
      await open(
        page,
        theme('long-labels', {
          layout: { menu: paths.map((to, index) => ({ to, label: labels[index] })) },
        }),
      )
      const nav = page.getByRole('navigation', { name: 'Main' })
      const settings = nav.getByRole('link', { name: labels[4]! })
      await expect(settings).toBeVisible()
      // The full name is still the link's text and its tooltip.
      await expect(settings).toHaveAttribute('title', labels[4]!)
      await expect(settings).toHaveText(labels[4]!)
      const fits = async (locator: Locator) => {
        const rect = (await locator.boundingBox())!
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.5)
      }
      await fits(settings)
      await fits(page.getByRole('button', { name: 'Search or run a command' }))
      await fits(page.locator('.avatar').first())
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1)
      await settings.click()
      await expect(page).toHaveURL(/\/settings/)
    })
  }

  test('between 1024 and 1100 px a rail falls back to the top bar', async ({ page }) => {
    await page.setViewportSize({ width: 1060, height: 900 })
    await open(page, t.navLeft)
    const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox()
    expect(nav!.height).toBeLessThan(80)
  })
})

test.describe('menu', () => {
  test('order, labels and hidden destinations follow the theme; Settings is added last', async ({
    page,
  }) => {
    await open(page, t.menu)
    const nav = page.getByRole('navigation', { name: 'Main' })
    const labels = (await nav.getByRole('link').allInnerTexts()).map((text) => text.trim())
    expect(labels).toEqual(['Talk', 'Today', 'Numbers', 'Settings'])
    // The Needs-you dot sits on the first destination, under its new name.
    await expect(
      nav.getByRole('link', { name: /^Talk/ }).getByRole('img', { name: 'Needs you' }),
    ).toBeVisible()
    await nav.getByRole('link', { name: 'Talk' }).click()
    await expect(page).toHaveURL(/\/chat/)
    // The palette lists the same menu.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search or run a command' })
    await expect(palette.getByRole('link', { name: 'Numbers' })).toBeVisible()
    await expect(palette.getByRole('link', { name: 'Team' })).toHaveCount(0)
    await expect(palette.getByRole('link', { name: 'Knowledge' })).toHaveCount(0)
    await expect(palette.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
  })

  test('a menu that starts elsewhere puts the Needs-you dot on its first entry', async ({
    page,
  }) => {
    await open(page, {
      ...t.menu,
      id: 'team-first',
      manifest: { layout: { menu: [{ to: '/team' }, { to: '/reports' }] } },
    })
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(
      nav.getByRole('link', { name: /^Team/ }).getByRole('img', { name: 'Needs you' }),
    ).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible()
  })

  test('the drawer follows the menu too', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page, t.menu)
    await page.getByRole('button', { name: 'Menu' }).click()
    const drawer = page.getByRole('dialog', { name: 'Menu' })
    await expect(drawer.getByRole('link', { name: 'Talk' })).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Knowledge' })).toHaveCount(0)
    await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible()
  })
})

test.describe('content width', () => {
  test('narrow caps the page, wide is Score’s own, full trims the gutters', async ({ page }) => {
    await open(page, t.narrow)
    const narrow = await box(page, 'main')
    expect(narrow.width).toBeLessThanOrEqual(962)
    expect(Math.abs(narrow.x - (1440 - narrow.x - narrow.width))).toBeLessThanOrEqual(2)
    await open(page, t.full)
    // The page is already in a custom look from the narrow theme, so `open` cannot tell when the full theme has replaced it.
    await expect.poll(async () => (await box(page, 'main')).width).toBeGreaterThan(1400)
  })

  test('wide is today’s width', async ({ browser }) => {
    const width = async (theme: MockTheme | null) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
      const page = await context.newPage()
      await open(page, theme)
      const rect = await box(page, 'main')
      await context.close()
      return rect.width
    }
    const own = await width(null)
    const wide = await width({
      ...t.narrow,
      id: 'wide',
      manifest: { layout: { contentWidth: 'wide' } },
    })
    expect(wide).toBeCloseTo(own, 0)
  })
})

test.describe('Chat', () => {
  test('plain is today’s look', async ({ page }) => {
    await open(page, t.navTop, '/chat/room-activity-feed')
    const own = '.chat-message--you .chat-text'
    await expect(page.locator(own)).toBeVisible()
    expect(await style(page, own, 'background-color')).toBe('rgb(18, 19, 26)')
    expect(
      await style(
        page,
        '.chat-message:not(.chat-message--you) .chat-message-body',
        'background-color',
      ),
    ).toBe('rgba(0, 0, 0, 0)')
  })

  test('bubbles: your messages on the right in --bubble-own, the agents’ on the left in a bubble', async ({
    page,
  }) => {
    await open(page, t.bubbles, '/chat/room-activity-feed')
    await page.locator('.chat-scroll').evaluate((el) => (el.scrollTop = 0))
    const own = page.locator('.chat-message--you .chat-text')
    await expect(own).toBeVisible()
    expect(await style(page, '.chat-message--you .chat-text', 'background-color')).toBe(
      'rgb(47, 93, 80)',
    )
    expect(await style(page, '.chat-message--you .chat-text', 'color')).toBe('rgb(255, 255, 255)')
    const thread = await box(page, '.chat-messages')
    const ownBox = await own.boundingBox()
    expect(ownBox!.x + ownBox!.width).toBeGreaterThan(thread.x + thread.width - 40)
    const agent = page.locator('.chat-message:not(.chat-message--you)').first()
    await expect(agent.locator('.agent-glyph')).toBeVisible()
    const bubble = agent.locator('.chat-message-body')
    expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    )
    expect(await bubble.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe(
      await bubble.evaluate((el) => getComputedStyle(el).borderTopRightRadius),
    )
    const glyph = await agent.locator('.agent-glyph').first().boundingBox()
    const bubbleBox = await bubble.boundingBox()
    expect(glyph!.x).toBeLessThan(bubbleBox!.x)
  })

  test('room list on the left by default', async ({ page }) => {
    await open(page, t.navTop, '/chat/room-activity-feed')
    const list = page.getByRole('complementary', { name: 'Rooms' })
    await expect(list).toBeVisible()
    expect((await list.boundingBox())!.x).toBeLessThan((await box(page, '.chat-thread')).x)
  })

  test('room list on the right', async ({ page }) => {
    await open(page, t.roomsRight, '/chat/room-activity-feed')
    const right = page.getByRole('complementary', { name: 'Rooms' })
    await expect(right).toBeVisible()
    expect((await right.boundingBox())!.x).toBeGreaterThan((await box(page, '.chat-thread')).x)
    // Same landmarks and links, whichever side.
    await expect(right.getByRole('link', { name: /activity-feed/ })).toBeVisible()
  })

  test('hidden until opened: a Rooms button opens the list as a drawer', async ({ page }) => {
    await open(page, t.roomsHidden, '/chat/room-activity-feed')
    await expect(page.getByRole('complementary', { name: 'Rooms' })).toBeHidden()
    const button = page.getByRole('button', { name: 'Rooms' })
    await expect(button).toBeVisible()
    // The thread has the room that was on the side.
    expect((await box(page, '.chat-thread')).width).toBeGreaterThan(700)
    await button.click()
    const drawer = page.getByRole('dialog', { name: 'Rooms' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: /activity-feed/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(button).toBeFocused()
  })
})

test.describe('shape', () => {
  const thread = '.chat-thread'
  const header = '.chat-thread-header'
  test('Score’s own cards, then flat/sharp/strong/compact', async ({ page }) => {
    await open(page, t.navTop)
    const own = {
      radius: await style(page, thread, 'border-top-left-radius'),
      shadow: await style(page, thread, 'box-shadow'),
      border: await style(page, thread, 'border-top-width'),
      padding: await style(page, header, 'padding-top'),
    }
    expect(own).toEqual({ radius: '28px', shadow: 'none', border: '1px', padding: '20px' })

    await open(page, t.compactSharp)
    expect(await style(page, thread, 'border-top-left-radius')).toBe('4px')
    expect(await style(page, thread, 'border-top-width')).toBe('2px')
    expect(await style(page, thread, 'box-shadow')).toBe('none')
    expect(parseFloat(await style(page, header, 'padding-top'))).toBeCloseTo(20 * 0.85, 1)
  })

  test('floating/round/none/airy', async ({ page }) => {
    await open(page, t.airyRound)
    expect(await style(page, thread, 'border-top-left-radius')).toBe('36px')
    expect(await style(page, thread, 'border-top-width')).toBe('0px')
    expect(await style(page, thread, 'box-shadow')).not.toBe('none')
    expect(parseFloat(await style(page, header, 'padding-top'))).toBeCloseTo(20 * 1.2, 1)
    // A protected card is never restyled by the shape settings.
    expect(await style(page, '.chat-approval', 'box-shadow')).toBe('none')
  })

  test('a radius in pixels and a raised card with a hairline', async ({ page }) => {
    await open(page, t.pxRadius)
    expect(await style(page, thread, 'border-top-left-radius')).toBe('18px')
    expect(await style(page, thread, 'box-shadow')).not.toBe('none')
    expect(await style(page, thread, 'border-top-width')).toBe('1px')
  })

  test('the shape reaches the other families too (Settings, Team, Chat)', async ({ page }) => {
    await open(page, t.airyRound, '/settings')
    expect(await style(page, '.settings-card', 'border-top-left-radius')).toBe('36px')
    expect(await style(page, '.settings-card', 'box-shadow')).not.toBe('none')
    await page.goto('/team')
    await expect(page.locator('html')).toHaveAttribute('data-elevation', 'floating')
    await expect(page.locator('.team-card').first()).toBeVisible()
    expect(await style(page, '.team-card', 'box-shadow')).not.toBe('none')
    await page.goto('/chat/room-activity-feed')
    await expect(page.locator('html')).toHaveAttribute('data-elevation', 'floating')
    await expect(page.locator('.chat-thread')).toBeVisible()
    expect(await style(page, '.chat-thread', 'box-shadow')).not.toBe('none')
    expect(await style(page, '.chat-thread', 'border-top-left-radius')).toBe('36px')
  })
})

test.describe('glass and background', () => {
  test('glass cards blur what is behind them; the picture is the page background', async ({
    page,
  }) => {
    const assets: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/assets/')) assets.push(new URL(request.url()).pathname)
    })
    await open(page, t.glassCover)
    expect(await style(page, 'body', 'background-image')).toContain(
      '/api/themes/glass-cover/assets/img/bg.png',
    )
    expect(await style(page, 'body', 'background-size')).toContain('cover')
    expect(assets).toContain('/api/themes/glass-cover/assets/img/bg.png')
    expect(await style(page, '.chat-thread', 'backdrop-filter')).toContain('blur')
    // The card colour at 70%: translucent, so the picture shows through.
    expect(await style(page, '.chat-thread', 'background-color')).toMatch(/\/ 0\.7\)$|, 0\.7\)$/)
  })

  test('tile repeats the picture and the dim veil is part of it', async ({ page }) => {
    await open(page, t.glassTile)
    expect(await style(page, 'body', 'background-repeat')).toContain('repeat')
    expect(await style(page, 'body', 'background-size')).toContain('auto')
    expect(await style(page, 'body', 'background-image')).toContain('linear-gradient')
  })

  test('a protected card keeps a solid background in front of the picture', async ({ page }) => {
    // The frozen fixture has no pending approval on a classic page any more (Now showed it), so this one asks the
    // fake server for a real one, with the theme routes mocked as in themes-boundary.
    await mockThemes(page, [t.glassCover], { active: t.glassCover.id, mode: 'light' })
    await page.route('**/api/themes/*/assets/**', async (route) =>
      route.fulfill({ body: samplePng(960, 640), contentType: 'image/png' }),
    )
    await pair(page)
    const room = await makeRoom(page, 'glass')
    await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
    await page.goto(`/chat/${room.id}`)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const ask = page.getByRole('group', { name: /^Approval: / }).last()
    await expect(ask.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
    await expect(ask).toBeVisible()
    const paint = await ask.evaluate((el) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return {
        color: style.backgroundColor,
        image: style.backgroundImage,
        blur: style.backdropFilter,
        onTop: !!top && el.contains(top),
      }
    })
    expect(paint).toEqual({ color: 'rgb(18, 19, 26)', image: 'none', blur: 'none', onTop: true })
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
  })

  test('a surface that holds a protected element without its own background stays solid', async ({
    page,
  }) => {
    await open(page, t.glassCover, '/team/builder')
    const holders = await page.evaluate(() =>
      [...document.querySelectorAll('[data-protected]:not(.agent-glyph):not(.needs-you-dot)')].map(
        (el) => {
          for (let node: Element | null = el.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.backdropFilter !== 'none') return { blurred: true, solid: false }
            const m = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(style.backgroundColor)
            if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && (!m?.[1] || Number(m[1]) === 1))
              return { blurred: false, solid: true }
          }
          return { blurred: false, solid: true }
        },
      ),
    )
    for (const holder of holders) expect(holder.blurred).toBe(false)
  })
})

test.describe('old themes still load', () => {
  test('layout.now and /now or /tasks menu paths are accepted and dropped from the menu', async ({
    page,
  }) => {
    // The new shell (/b) has its own look system and needs more of the API than the frozen fixture offers, so only
    // the classic shell's menu is checked here.
    await open(page, t.legacy)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const nav = page.getByRole('navigation', { name: 'Main' })
    const labels = (await nav.getByRole('link').allInnerTexts()).map((text) => text.trim())
    expect(labels).toEqual(['Talk', 'Settings'])
    await expect(nav.getByRole('link', { name: 'Today' })).toHaveCount(0)
    await expect(nav.getByRole('link', { name: 'Tasks' })).toHaveCount(0)
  })

  test('the boot cache holds the resolved layout', async ({ page }) => {
    await open(page, t.harbour, '/chat/room-activity-feed')
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache')!))
    expect(cache.attributes['data-radius']).toBe('round')
    expect(cache.layout.nav).toBe('left')
  })

  test('the menu is on screen before the theme arrives, from the cached layout', async ({
    page,
  }) => {
    await open(page, t.menu)
    await expect(page.getByRole('link', { name: 'Talk' })).toBeVisible()
    // Second visit: the theme detail answers late; the cached layout already shows the menu.
    await page.route('**/api/themes/menu', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      await route.fallback().catch(() => undefined)
    })
    await page.reload()
    await expect(page.getByRole('link', { name: 'Talk' })).toBeVisible({ timeout: 2000 })
  })
})
