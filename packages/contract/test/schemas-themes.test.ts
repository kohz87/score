import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import { themeCases } from './schemas-cases-themes.ts'

describe.each(themeCases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('the colour tokens a theme may set are colours: the halo sizes are not on the list', () => {
  // `--halo-ring` and `--halo-glow` are px sizes in tokens.css; a colour there would break the running-step halo.
  expect(contract.THEME_COLOR_TOKENS).not.toContain('halo-glow')
  expect(contract.THEME_COLOR_TOKENS).not.toContain('halo-ring')
  for (const token of ['halo-glow', 'halo-ring'])
    expect(
      contract.ThemeManifestSchema.safeParse({
        format: 1,
        id: 'x',
        name: 'X',
        colors: { light: { [token]: '#ffffff' } },
      }).success,
    ).toBe(false)
})

test('C4: a theme save may carry assets, keep and licences, and nothing unsafe', () => {
  const base = { manifest: { format: 1, id: 'mine', name: 'Mine' }, css: '', etag: 'abc' }
  const ok = contract.ThemeSaveSchema.safeParse({
    ...base,
    assets: { 'img/a.png': 'iVBORw0KGgo=' },
    keep: ['fonts/f.woff2'],
    licenses: { 'OFL.txt': 'text' },
  })
  expect(ok.success).toBe(true)
  for (const extra of [
    { assets: { 'img/a.svg': 'iVBORw0KGgo=' } },
    { assets: { '../a.png': 'iVBORw0KGgo=' } },
    { assets: { 'img/a.png': 'not base64!' } },
    { assets: { 'img/a.png': 'abc' } },
    { keep: ['css/x.png'] },
    { licenses: { 'NOTICE.txt': 'x' } },
  ])
    expect(contract.ThemeSaveSchema.safeParse({ ...base, ...extra }).success).toBe(false)
})

// Third gate, finding 5: a menu label that shows nothing would blank a destination (Settings included).
describe('third gate 5: manifest menu labels need a visible character', () => {
  const manifest = (label: string) => ({
    format: 1,
    id: 'x',
    name: 'X',
    layout: { menu: [{ to: '/settings', label }] },
  })
  const accepted = (label: string) =>
    contract.ThemeManifestSchema.safeParse(manifest(label)).success

  test.each([
    ['a space', ' '],
    ['several spaces', '     '],
    ['a tab and a newline', '\t\n'],
    ['a no-break space', ' '],
    ['an ideographic space', '　'],
    ['a zero width space', '​'],
    ['zero width non-joiner and joiner', '‌‍'],
    ['left-to-right and right-to-left marks', '‎‏'],
    ['a word joiner', '⁠'],
    ['a byte order mark', '﻿'],
    ['a soft hyphen', '­'],
    ['a bidi override and its end', '‮‬'],
    ['an isolate', '⁦⁩'],
    ['invisible math operators', '⁡⁤'],
    ['a Mongolian vowel separator', '᠎'],
    ['a combining grapheme joiner', '͏'],
    ['variation selectors', '️︀'],
    ['a braille blank', '⠀'],
    ['a Hangul filler', 'ㅤᅟᅠﾠ'],
    ['a tag space', '\u{e0020}'],
    ['a lone combining mark', '́'],
    ['a control character', '\u0007'],
    ['an Arabic letter mark', '؜'],
    ['everything mixed', ' ​⁠﻿　 '],
  ])('%s is refused', (_name, label) => {
    expect(accepted(label)).toBe(false)
  })

  test('labels with words (and wide, accented, emoji or symbol-only ones) are accepted', () => {
    for (const label of [
      'Home',
      ' Home ',
      'Ho​me',
      'é',
      'ホーム',
      'تنظيم',
      '⚙',
      '🛠',
      '•',
      '1',
      'á',
    ])
      expect(accepted(label), JSON.stringify(label)).toBe(true)
  })

  test('hasVisibleCharacter says the same', () => {
    expect(contract.hasVisibleCharacter(' ​')).toBe(false)
    expect(contract.hasVisibleCharacter(' x ')).toBe(true)
  })
})
