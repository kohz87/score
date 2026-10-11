import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from '../errors.ts'

// Moves a file to a new name without ever replacing anything, and without ever deleting a file that someone else put
// at the old name meanwhile. Same approach as the workspace move (workspace.ts): `link` never replaces, and the old
// name is removed by first renaming it (atomically, whatever is there) to a private name and unlinking that only
// if it is still the file that was linked. There is deliberately no fallback to a replacing `rename`: on a
// filesystem without hard links the move is refused.

const UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV', 'ENOTSUP'])

export function parkedNameFor(source: string): string {
  return path.join(path.dirname(source), `.score-move-${randomBytes(8).toString('hex')}`)
}

/** Flushes a folder's entries to disk. Where the platform can't (some filesystems, Windows), this is a no-op. */
export async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP')
      throw error
  } finally {
    await handle?.close()
  }
}

/** Puts a parked file back at `source`, never replacing something that appeared there; otherwise keeps it visibly. */
export async function restoreParked(parked: string, source: string): Promise<string | null> {
  const ext = path.extname(source)
  const stem = source.slice(0, source.length - ext.length)
  for (let n = 0; n < 20; n += 1) {
    const target = n === 0 ? source : `${stem} (conflict copy${n === 1 ? '' : ` ${n}`})${ext}`
    try {
      await fs.link(parked, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      return null // keep the parked file where it is rather than lose it
    }
    await fs.unlink(parked).catch(() => undefined)
    return n === 0 ? null : target
  }
  return null
}

/** Removes `source` only if it is still the file `st` describes; a newer file there goes back (see top comment). */
export async function removeOldName(
  source: string,
  parked: string,
  st: { dev: number; ino: number },
): Promise<void> {
  const parkedStat = await fs.rename(source, parked).then(
    () => fs.lstat(parked),
    // Removed by someone else meanwhile: the move has happened.
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (parkedStat !== null) {
    if (parkedStat.dev === st.dev && parkedStat.ino === st.ino) await fs.unlink(parked)
    // A newer file took the old name's place after the link: it goes back (or is kept as a visible copy).
    else await restoreParked(parked, source)
  }
}

const exists = () => new HttpError(409, 'exists', 'A file with that name already exists.')

/**
 * `parked` (optional) is where the old name is moved while it is removed; the caller records it so an interrupted
 * move can clean up. Throws 404 when the source is gone, 409 when the destination exists, and refuses when hard
 * links aren't available.
 */
export async function moveNoReplace(
  source: string,
  dest: string,
  parked: string = parkedNameFor(source),
): Promise<void> {
  const st = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new HttpError(404, 'not_found', 'Couldn’t find that file.')
    throw error
  })
  try {
    await fs.link(source, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw exists()
    if (code !== undefined && UNSUPPORTED.has(code))
      throw new HttpError(
        500,
        'hard_links_unsupported',
        'Couldn’t move that file. Knowledge needs a folder on a filesystem with hard links.',
      )
    throw error
  }
  await removeOldName(source, parked, st)
  await syncDir(path.dirname(source))
  await syncDir(path.dirname(dest))
}
