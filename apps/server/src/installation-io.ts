import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The whole text or an error, then rename, then the directory: a reader sees the old file or the new one. */
export function writeDurable(file: string, text: string): void {
  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeFileSync(fd, text) // loops until everything is written
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  const dirFd = openSync(dirname(file), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}
