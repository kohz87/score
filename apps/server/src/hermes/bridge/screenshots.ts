import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { ProfileNameSchema, resolveHermesHome } from '../live/paths.ts'
import type { MediaStore } from '../../media/store.ts'

export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const NAME = /^browser_screenshot_[0-9a-f]{1,64}\.png$/
const DIRS = [join('cache', 'screenshots'), 'browser_screenshots']

function profileDir(hermesHome: string, profile: string): string | null {
  const parsed = ProfileNameSchema.safeParse(profile)
  if (!parsed.success) return null
  return parsed.data === 'default' ? hermesHome : join(hermesHome, 'profiles', parsed.data)
}

/**
 * Reads a browser_vision screenshot named by a tool result. The path is untrusted: it must be a regular file,
 * not a symlink, named like Hermes names screenshots, directly inside the profile's own screenshot directory.
 */
export function readHermesScreenshot(
  hermesHome: string,
  profile: string,
  rawPath: unknown,
): Buffer | null {
  try {
    if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 4096) return null
    if (rawPath.includes('\0') || !isAbsolute(rawPath) || normalize(rawPath) !== rawPath)
      return null
    const name = basename(rawPath)
    if (!NAME.test(name)) return null
    const home = profileDir(hermesHome, profile)
    if (!home) return null
    const dir = dirname(rawPath)
    const allowed = DIRS.some((sub) => dir === join(home, sub))
    if (!allowed) return null
    // The directory itself may sit behind a symlinked home; the file and its resolved location may not.
    if (realpathSync(rawPath) !== join(realpathSync(dir), name)) return null
    const link = lstatSync(rawPath)
    if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_SCREENSHOT_BYTES) return null
    const fd = openSync(rawPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.ino !== link.ino ||
        stat.size > MAX_SCREENSHOT_BYTES ||
        stat.size === 0
      )
        return null
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (n === 0) break
        offset += n
      }
      return offset === bytes.length ? bytes : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export type ScreenshotImporter = (profile: string, path: unknown) => string | null

/** Screenshot path -> media id; any failure (refused path, not an image, quota) is just "no image". */
export function createScreenshotImporter(
  config: { hermesHome?: string | undefined },
  media: MediaStore,
): ScreenshotImporter {
  const hermesHome = resolveHermesHome(config.hermesHome)
  return (profile, path) => {
    const bytes = readHermesScreenshot(hermesHome, profile, path)
    if (!bytes) return null
    try {
      return media.store(bytes).mediaId
    } catch {
      return null
    }
  }
}
