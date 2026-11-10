import fs from 'node:fs'
import { join } from 'node:path'
import { redactBounded } from '../../redact.ts'
import { profileHome, splitRoutineId } from './routines.ts'

// Decision 183: a repeating job's results reach a Score chat. Hermes saves each run's output as Markdown under
// <profile home>/cron/output/<job id>/<timestamp>.md (cron/jobs.py save_job_output); Score reads those files read-only,
// never writes or removes them, and posts each one once.

const MAX_FILES = 20
const MAX_BYTES = 64 * 1024
const FILE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/

/** The run's answer: the part under "## Response" when Hermes's document has one, else the whole document. */
export function outputText(doc: string): string {
  const at = doc.search(/^#{2,3} Response\s*$/m)
  const text = at < 0 ? doc : doc.slice(at).replace(/^#{2,3} Response\s*\n/, '')
  return text.trim()
}

/** The job's saved results written after `since`, oldest first, redacted. A missing folder is no results yet. */
export function readRoutineOutputs(
  hermesHome: string,
  id: string,
  since: string,
): { file: string; at: string; text: string }[] {
  const { profile, jobId } = splitRoutineId(id)
  const home = profileHome(hermesHome, profile)
  if (!home) return []
  const folder = join(home, 'cron', 'output', jobId)
  let names: string[]
  try {
    if (!fs.lstatSync(folder).isDirectory()) return []
    names = fs.readdirSync(folder).filter((name) => FILE.test(name))
  } catch {
    return []
  }
  const after = Date.parse(since)
  const found: { file: string; at: string; text: string }[] = []
  for (const name of names) {
    const path = join(folder, name)
    try {
      const stat = fs.lstatSync(path)
      if (!stat.isFile() || stat.mtimeMs <= after) continue
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let text: string
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES))
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, length).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      found.push({
        file: name,
        at: new Date(stat.mtimeMs).toISOString(),
        text: redactBounded(outputText(text), 16_000),
      })
    } catch {
      // A file being written or removed now is picked up (or not) on the next look.
    }
  }
  return found.sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_FILES)
}
