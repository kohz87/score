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

/**
 * The run's answer, as Hermes itself reads its run documents (cron/scheduler_prompt.py `_archive_answer`): a framed
 * document states the prompt's and the answer's lengths, so the answer is taken by length and nothing in the prompt can
 * pass for it; an older document's answer is under its last "## Response" heading. A document without an answer (a
 * failed or blocked run, which repeats the prompt) yields null: the chat is told the run didn't answer, never shown it.
 */
export function outputText(doc: string): string | null {
  // Hermes counts characters (code points); JavaScript strings count UTF-16 units.
  const chars = Array.from(doc)
  const prompt = /^\*\*Prompt Characters:\*\* (\d+)\n## Prompt\n\n/m.exec(doc)
  if (prompt) {
    const promptEnd =
      Array.from(doc.slice(0, prompt.index + prompt[0].length)).length + Number(prompt[1]) + 2
    const rest = chars.slice(promptEnd).join('')
    const response = /^\*\*Response Characters:\*\* (\d+)\n## Response\n\n/.exec(rest)
    if (!response) return null
    const answer = Array.from(rest.slice(response[0].length))
    if (answer.length !== Number(response[1]) + 1) return null
    return answer.slice(0, -1).join('').trim() || null
  }
  const at = doc.lastIndexOf('## Response')
  if (at < 0) return null
  return doc.slice(at + '## Response'.length).trim() || null
}

/** Each folder from the profile home down to the job's output: a real folder, never a link Score would follow. */
function realFolders(home: string, parts: string[]): string | null {
  let path = home
  for (const part of parts) {
    path = join(path, part)
    try {
      if (!fs.lstatSync(path).isDirectory()) return null
    } catch {
      return null
    }
  }
  return path
}

/** The job's saved results written after `since`, oldest first, redacted. A missing folder is no results yet. */
export function readRoutineOutputs(
  hermesHome: string,
  id: string,
  since: string,
): { file: string; at: string; text: string | null }[] {
  const { profile, jobId } = splitRoutineId(id)
  const home = profileHome(hermesHome, profile)
  if (!home) return []
  const folder = realFolders(home, ['cron', 'output', jobId])
  if (!folder) return []
  let names: string[]
  try {
    names = fs.readdirSync(folder).filter((name) => FILE.test(name))
  } catch {
    return []
  }
  const after = Date.parse(since)
  const found: { file: string; at: string; text: string | null }[] = []
  for (const name of names) {
    const path = join(folder, name)
    try {
      const stat = fs.lstatSync(path)
      // `since` is the last result already looked at: results written at that same moment are read again, and the posted
      // record keeps each one from being posted twice.
      if (!stat.isFile() || stat.mtimeMs < after) continue
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      let text: string
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES))
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, length).toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
      const answer = outputText(text)
      found.push({
        file: name,
        at: new Date(stat.mtimeMs).toISOString(),
        // Null: the run didn't answer (failed or blocked); the chat gets a plain line, never the document.
        text: answer === null ? null : redactBounded(answer, 16_000),
      })
    } catch {
      // A file being written or removed now is picked up (or not) on the next look.
    }
  }
  // Oldest first, a page at a time: the caller moves `since` on as it posts, so a long backlog is worked through in order.
  return found
    .sort((a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file))
    .slice(0, MAX_FILES)
}
