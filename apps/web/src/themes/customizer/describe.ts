import type { ThemeManifest } from '@score/contract'
import { menuRows } from './draft.ts'

// What a theme changes, in plain words: the list the import preview shows before anything is installed.

const kb = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const navNames = {
  top: 'at the top',
  left: 'a rail on the left',
  right: 'a rail on the right',
  launcher: 'a menu button',
}
const radiusNames = { sharp: 'sharp', soft: 'soft', round: 'round' }

function lookLines(
  look: Pick<ThemeManifest, 'colors' | 'fonts' | 'shape' | 'layout' | 'background'>,
): string[] {
  const out: string[] = []
  const light = Object.keys(look.colors?.light ?? {}).length
  const dark = Object.keys(look.colors?.dark ?? {}).length
  if (light + dark > 0)
    out.push(
      `Colours: ${plural(light, 'colour')} in light mode, ${plural(dark, 'colour')} in dark mode.`,
    )
  const fonts = look.fonts
  if (fonts) {
    const roles = (['heading', 'body', 'code'] as const)
      .filter((key) => fonts[key])
      .map(
        (key) =>
          `${key === 'heading' ? 'headings' : key === 'body' ? 'text' : 'code'} in ${fonts[key]}`,
      )
    const files = fonts.faces?.length ?? 0
    if (roles.length || files)
      out.push(
        `Fonts: ${[roles.join(', '), files ? `${plural(files, 'font file')} included` : ''].filter(Boolean).join('; ')}.`,
      )
  }
  const shape = look.shape
  if (shape) {
    const parts = [
      shape.radius !== undefined
        ? `${typeof shape.radius === 'number' ? `${shape.radius} px` : radiusNames[shape.radius]} corners`
        : '',
      shape.density ? `${shape.density} spacing` : '',
      shape.border ? `${shape.border === 'hairline' ? 'thin' : shape.border} borders` : '',
      shape.elevation ? `${shape.elevation} cards` : '',
      shape.surface ? `${shape.surface} card surface` : '',
    ].filter(Boolean)
    if (parts.length) out.push(`Shape: ${parts.join(', ')}.`)
  }
  const layout = look.layout
  if (layout) {
    const parts = [
      layout.nav ? `navigation as ${navNames[layout.nav]}` : '',
      layout.contentWidth ? `${layout.contentWidth} pages` : '',
    ].filter(Boolean)
    if (parts.length) out.push(`Layout: ${parts.join(', ')}.`)
    if (layout.menu) {
      const rows = menuRows({
        layout,
        id: 'x',
        name: 'x',
        format: 1,
        version: '1.0.0',
      } as ThemeManifest)
      const hidden = rows.filter((row) => row.hidden).length
      const renamed = rows.filter((row) => row.label).length
      out.push(
        `Menu: ${plural(rows.length - hidden, 'page')} shown${hidden ? `, ${hidden} hidden` : ''}${renamed ? `, ${renamed} renamed` : ''}, in its own order.`,
      )
    }
    if (layout.now)
      out.push(
        `Now: ${plural(layout.now.columns, 'column')} and ${plural(layout.now.cards.length, 'card')} in its own order.`,
      )
    if (layout.chat) {
      const parts = [
        layout.chat.messages ? `messages as ${layout.chat.messages}` : '',
        layout.chat.roomList
          ? `room list ${layout.chat.roomList === 'hidden-until-opened' ? 'hidden until opened' : layout.chat.roomList}`
          : '',
      ].filter(Boolean)
      if (parts.length) out.push(`Chat: ${parts.join(', ')}.`)
    }
  }
  if (look.background?.image)
    out.push(
      `Background: a picture, ${look.background.fit === 'tile' ? 'tiled' : 'filling the window'}${look.background.dim ? `, dimmed ${look.background.dim}%` : ''}.`,
    )
  return out
}

export function describeChanges(manifest: ThemeManifest, css: string): string[] {
  const out = lookLines(manifest)
  if (manifest.views?.user) {
    const own = lookLines(manifest.views.user)
    out.push(
      `Chat-first view: has settings of its own${own.length ? ` (${own.map((line) => line.split(':')[0]!.toLowerCase()).join(', ')})` : ''}.`,
    )
  }
  if (css.trim()) out.push(`Custom CSS: ${kb(new TextEncoder().encode(css).length)}.`)
  return out.length ? out : ['It changes nothing: Score’s own look stays.']
}
