// Built-in theme packs (PLAN 8.3, decision 84). Colours, radius and density live in packs/<id>.css (tokens only);
// this file is the registry the picker, the loader and the tests read. `score` is today's look, defined by tokens.css.
export type PackLayout = 'top' | 'side'
export type PackDensity = 'comfortable' | 'compact'

export type Pack = {
  id: string
  name: string
  blurb: string
  layout: PackLayout
  density: PackDensity
  /** Loads the pack's fonts (OFL-1.1 @fontsource files) the first time the pack is used. */
  fonts: (() => Promise<unknown>) | null
}

export const packs = [
  {
    id: 'score',
    name: 'Score',
    blurb: 'The default: soft grey ground, round white cards.',
    layout: 'top',
    density: 'comfortable',
    fonts: null,
  },
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Warm off-white, serif headings, gentle corners.',
    layout: 'top',
    density: 'comfortable',
    fonts: async () =>
      Promise.all([
        import('@fontsource/source-serif-4/500.css'),
        import('@fontsource/source-serif-4/600.css'),
        import('@fontsource/source-serif-4/700.css'),
      ]),
  },
  {
    id: 'night',
    name: 'Night shift',
    blurb: 'Deep blue-black with cool tones, navigation on the left.',
    layout: 'side',
    density: 'comfortable',
    fonts: null,
  },
  {
    id: 'dense',
    name: 'Dense',
    blurb: 'Neutral greys, Inter, tight spacing for big screens.',
    layout: 'side',
    density: 'compact',
    fonts: async () =>
      Promise.all([
        import('@fontsource/inter/400.css'),
        import('@fontsource/inter/500.css'),
        import('@fontsource/inter/600.css'),
        import('@fontsource/inter/700.css'),
      ]),
  },
] as const satisfies readonly Pack[]

export type PackId = (typeof packs)[number]['id']
export const defaultPackId: PackId = 'score'

export function findPack(id: string | null | undefined): Pack {
  return packs.find((pack) => pack.id === id) ?? packs[0]
}
