import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { THEME_ASSET_PATH } from '@score/contract'
import { builtinAssetRoot } from './builtin.ts'
import { ASSET_DIRS, type ThemeContext } from './store-types.ts'

/**
 * The one place asset paths are resolved (K2 X4). Walks the folders from the theme's own folder down (`<id>`, `assets`,
 * then `tail`), and refuses the path (null) if any step is a symlink, a missing entry, or the wrong kind, so a link
 * planted anywhere on the way (a folder as much as the file) is never followed. The themes root and Score's home are
 * the owner's own and may be links. Built-ins are walked from their shipped folder the same way.
 */
function safeAssetPath(
  context: ThemeContext,
  id: string,
  tail: string[],
  want: 'file' | 'dir',
): string | null {
  const shipped = builtinAssetRoot(id)
  let current = shipped ? dirname(shipped) : context.root
  const steps = shipped ? ['assets', ...tail] : [id, 'assets', ...tail]
  for (const [index, step] of steps.entries()) {
    current = join(current, step)
    let info
    try {
      info = lstatSync(current)
    } catch {
      return null
    }
    const last = index === steps.length - 1
    if (info.isSymbolicLink() || !(last && want === 'file' ? info.isFile() : info.isDirectory()))
      return null
  }
  return current
}

/** Asset paths as `fonts/x.woff2`, sorted; only regular files, with no symlink on the way (see `safeAssetPath`). */
export function themeAssets(context: ThemeContext, id: string): string[] {
  const found: string[] = []
  for (const dir of ASSET_DIRS) {
    const folder = safeAssetPath(context, id, [dir], 'dir')
    if (!folder) continue
    for (const name of readdirSync(folder).sort()) {
      const path = `${dir}/${name}`
      if (THEME_ASSET_PATH.test(path) && safeAssetPath(context, id, [dir, name], 'file'))
        found.push(path)
    }
  }
  return found
}

/**
 * The bytes of one stored asset, or null when the path isn't a well-formed asset path or isn't a regular file with no
 * symlink on the way. Routes (serve, export) and the save-with-files path all read through here.
 */
export function readThemeAsset(context: ThemeContext, id: string, path: string): Buffer | null {
  if (!THEME_ASSET_PATH.test(path)) return null
  const file = safeAssetPath(context, id, path.split('/'), 'file')
  if (!file) return null
  let fd: number | null = null
  try {
    // O_NOFOLLOW closes the gap between the check and the open for the file itself.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    return fstatSync(fd).isFile() ? readFileSync(fd) : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
