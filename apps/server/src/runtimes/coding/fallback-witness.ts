import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { LAUNCHES_DIR } from '../../installation.ts'
import { mkdirDurable } from '../../locks/os-lock.ts'

// What a process-group fallback launch leaves beside the installation journal (outside the restorable home), next to
// its journal records: the routing (which agent and run) and the identities of the processes of its group seen so far.
// The journal's records carry the leader's identity; these two facts are the rest that a restored database would lose
// (7.7a re-review 2026-10-12 #6).

const FILE = 'fallback.json'
const Witness = z.object({
  launch: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  agentId: z.string().min(1),
  members: z.array(
    z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/) }),
  ),
  at: z.number(),
})
export type FallbackWitness = z.infer<typeof Witness>

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Replaces the file whole (temp name, fsync, rename, directory fsync): a reader sees the old or the new, never a part. */
export function writeFallbackWitness(namespaceDir: string, witness: FallbackWitness): void {
  const dir = join(namespaceDir, LAUNCHES_DIR, witness.launch)
  mkdirDurable(dir)
  const tmp = join(dir, `.${FILE}.${process.pid}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    const data = Buffer.from(JSON.stringify(Witness.parse(witness)) + '\n')
    let off = 0
    while (off < data.length) off += writeSync(fd, data, off, data.length - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, join(dir, FILE))
  fsyncDir(dir)
}

/** The witness of a launch, or null when absent or not valid. */
export function readFallbackWitness(namespaceDir: string, launch: string): FallbackWitness | null {
  try {
    const witness = Witness.parse(
      JSON.parse(readFileSync(join(namespaceDir, LAUNCHES_DIR, launch, FILE), 'utf8')),
    )
    return witness.launch === launch ? witness : null
  } catch {
    return null
  }
}
