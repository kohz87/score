import { describe, expect, it } from 'vitest'
import { describeChanges } from './describe.ts'
import { emptyManifest } from './draft.ts'

describe('describeChanges', () => {
  it('says so when a theme changes nothing', () => {
    expect(describeChanges(emptyManifest('x', 'X'), '')).toEqual([
      'It changes nothing: Score’s own look stays.',
    ])
  })

  it('lists each part a theme sets in plain words', () => {
    const lines = describeChanges(
      {
        ...emptyManifest('harbour', 'Harbour'),
        colors: { light: { ground: '#fff', card: '#eee' }, dark: { ground: '#000' } },
        fonts: {
          heading: 'Source Serif 4',
          faces: [{ family: 'A', src: 'asset:fonts/a.woff2', weight: '400', style: 'normal' }],
        },
        shape: { radius: 12, surface: 'glass', border: 'hairline' },
        layout: {
          nav: 'left',
          menu: [{ to: '/now', label: 'Home' }, { to: '/settings' }],
          now: { columns: 2, cards: [{ card: 'needs-you', span: 1 }] },
          chat: { messages: 'bubbles', roomList: 'hidden-until-opened' },
        },
        background: { image: 'asset:img/b.png', fit: 'tile', dim: 30 },
      },
      '.x { color: red }',
    )
    expect(lines).toEqual([
      'Colours: 2 colours in light mode, 1 colour in dark mode.',
      'Fonts: headings in Source Serif 4; 1 font file included.',
      'Shape: 12 px corners, thin borders, glass card surface.',
      'Layout: navigation as a rail on the left.',
      'Menu: 2 pages shown, 5 hidden, 1 renamed, in its own order.',
      'Now: 2 columns and 1 card in its own order.',
      'Chat: messages as bubbles, room list hidden until opened.',
      'Background: a picture, tiled, dimmed 30%.',
      'Custom CSS: 17 bytes.',
    ])
  })
})
