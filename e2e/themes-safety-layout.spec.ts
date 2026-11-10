import { expect, test, type Locator } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { layoutThemes, theme as layoutTheme } from './themes-layout-fixtures.ts'
import { samplePng } from './png.ts'
import { pair } from './pair.ts'
import { allowIt, isOnTop, startApproval } from './themes-decision.ts'

// Layout options (PLAN 9.3): the guarantees of the protected surfaces hold in every combination of navigation,
// width, shape, glass and background picture. The server is the real fake-mode one; the themes are mocked.
const hostileLayouts: Record<string, MockTheme> = {
  glassCover: layoutThemes.glassCover,
  glassTileDim: layoutTheme('glass-tile-dim', {
    shape: { surface: 'glass', elevation: 'floating', border: 'strong', radius: 'round' },
    background: { image: 'asset:img/bg.png', fit: 'tile', dim: 80 },
  }),
  // A near-white picture-on-glass theme whose colours would put pale text on the pale card.
  glassPale: layoutTheme('glass-pale', {
    colors: {
      light: { card: '#f4f4f4', ink: '#f0f0f0', 'panel-ink': '#f0f0f0', 'panel-card': '#f4f4f4' },
    },
    shape: { surface: 'glass', elevation: 'raised' },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 0 },
  }),
  rightNarrowBubbles: layoutTheme('right-narrow', {
    shape: { density: 'airy', surface: 'glass', radius: 'round' },
    layout: {
      nav: 'right',
      contentWidth: 'narrow',
      chat: { messages: 'bubbles', roomList: 'hidden-until-opened' },
    },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 30 },
  }),
  launcherFullCompact: layoutTheme('launcher-full', {
    shape: { density: 'compact', radius: 'sharp', border: 'none', elevation: 'flat' },
    layout: { nav: 'launcher', contentWidth: 'full', chat: { roomList: 'right' } },
  }),
  leftHiddenMenu: layoutTheme('left-hidden', {
    layout: { nav: 'left', menu: [] },
    shape: { surface: 'glass' },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 10 },
  }),
}

async function assertProtectedHolds(card: Locator) {
  await card.scrollIntoViewIfNeeded()
  const allow = card.getByRole('button', { name: 'Allow', exact: true })
  const deny = card.getByRole('button', { name: 'Don’t allow', exact: true })
  await expect(allow).toBeVisible()
  await expect(deny).toBeVisible()
  expect(await isOnTop(allow)).toBe(true)
  expect(await isOnTop(deny)).toBe(true)
  const paint = await card.evaluate((el) => {
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const parse = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value)
      if (!m) return null
      const parts = m[1]!
        .split(/[,/ ]+/)
        .filter(Boolean)
        .map(Number)
      return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 }
    }
    const style = getComputedStyle(el)
    const bg = parse(style.backgroundColor)
    // Every readable part against the nearest opaque background behind it.
    const ratios = [...el.querySelectorAll('button, h2, h3, p, strong, code')]
      .filter((node) => node.getClientRects().length > 0 && (node.textContent ?? '').trim())
      .map((node) => {
        const fg = parse(getComputedStyle(node).color)
        let backing = null
        for (let n: Element | null = node; n && !backing; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor)
          if (c && c.alpha >= 1) backing = c
        }
        if (!fg || !backing) return 0
        const a = lum(fg.rgb)
        const b = lum(backing.rgb)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
    return {
      alpha: bg?.alpha ?? 0,
      image: style.backgroundImage,
      blur: style.backdropFilter,
      opacity: style.opacity,
      minContrast: Math.min(...ratios),
    }
  })
  // Solid, no picture or blur behind its text, readable.
  expect(paint.alpha).toBe(1)
  expect(paint.image).toBe('none')
  expect(paint.blur).toBe('none')
  expect(paint.opacity).toBe('1')
  expect(paint.minContrast).toBeGreaterThanOrEqual(4.5)
}

// The shape and background options still reach the new shell; the navigation, menu, width and chat-list options belong
// to the classic layout (decision 131) and the shell ignores them, so those themes also prove that they change nothing.
test.describe('layout options never weaken a protected surface', () => {
  for (const [name, layout] of Object.entries(hostileLayouts)) {
    test(`${name}: the approval in the room and the Needs-you marker`, async ({ page }) => {
      const look: Look = { active: layout.id, mode: 'light' }
      const { card, allow } = await startApproval(page, [layout], look, {}, async (frame) => {
        await frame.route('**/api/themes/*/assets/**', (route) =>
          route.fulfill({ body: samplePng(960, 640), contentType: 'image/png' }),
        )
      })
      if (name === 'glassPale') {
        // Pale text on a pale glass card: the protected surfaces wear Score's own colours (the contrast fallback), so
        // the card stays readable whether or not the guard also switches the theme off.
        await page.waitForTimeout(1500)
        await assertProtectedHolds(card)
        await allowIt(card)
        return
      }
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await assertProtectedHolds(card)
      // Needs-you stays in the dock.
      await expect(page.locator('.bold-chat-needs[data-protected]').first()).toBeAttached()
      // Settings can't be hidden, and the way back is on its page.
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: /^Look/ })
        .click()
      await expect(
        page.getByRole('button', { name: 'Reset the look on this device' }),
      ).toBeVisible()
      // No banner: the guard didn't have to switch the theme off.
      await expect(page.locator('.look-banner')).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.getByRole('button', { name: 'Score, go to the team room' }).click()
      await expect(allow).toBeVisible()
      await allowIt(card)
    })
  }

  test('a theme can’t take Settings out of the shell, whatever its old navigation options say', async ({
    page,
  }) => {
    for (const nav of ['top', 'left', 'right', 'launcher'] as const) {
      const hide = layoutTheme(`hide-${nav}`, { layout: { nav, menu: [{ to: '/chat' }] } })
      await mockThemes(page, [hide], { active: hide.id, mode: 'light' })
      await pair(page)
      await page.goto('/b?open=1')
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
      // Room, Agents, Knowledge (3.19.0), Tasks (3.16.0) and Screens (3.18.0); Recipes left the bar in 3.27.0: the shell's own buttons, whatever the theme's menu says.
      await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button')).toHaveCount(
        5,
      )
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
  })
})
