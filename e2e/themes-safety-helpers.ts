import { hostileCss, hostileManifest, type MockTheme } from './themes-fixtures.ts'

/** The hostile theme the safety specs rely on: dangerous CSS, failing contrast and a manifest that tries too much. */
export const hostile: MockTheme = {
  id: 'hostile',
  name: 'Hostile',
  source: 'imported',
  manifest: hostileManifest,
  css: hostileCss,
}
