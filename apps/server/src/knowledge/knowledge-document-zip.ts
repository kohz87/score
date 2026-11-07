import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  KnowledgeAuthor,
  KnowledgeHistoryStatus,
  KnowledgeUnzipResult,
  KnowledgeZipPreview,
} from '@score/contract'
import { HttpError } from '../errors.ts'
import { bytesMatch } from './doc-types.ts'
import { runWorker, ZIP_LIMITS, ZIP_TIMEOUT_MS, zipFailure } from './extract.ts'
import { KnowledgeDocumentFiles } from './knowledge-document-files.ts'
import {
  MAX_EVENTS,
  cleanSegments,
  withoutBytes,
  type OnConflict,
  type Unpacked,
} from './knowledge-document-model.ts'

/** Zip previews and zip imports for documents in the vault. */
export class KnowledgeDocumentZip extends KnowledgeDocumentFiles {
  // ---- zip -------------------------------------------------------------------------------------------------

  async zipPreview(bytes: Buffer): Promise<KnowledgeZipPreview> {
    if (!bytesMatch('zip', bytes))
      throw new HttpError(415, 'unsupported_type', 'That isn’t a zip file.')
    const listed = await this.listZip(bytes)
    if (!listed.ok) throw zipFailure(listed)
    if (!('entries' in listed))
      throw new HttpError(415, 'unsupported_type', 'Couldn’t read that zip file.')
    return {
      entries: listed.entries,
      more: listed.more,
      extractCount: listed.entries.filter((entry) => entry.action === 'extract').length,
    }
  }

  /** Unpacks a zip into `folder` as one commit. Every file goes through the same checks as a single upload. */
  async unzip(
    zipBytes: Buffer,
    zipName: string,
    folderInput: string,
    onConflict: OnConflict,
    author: KnowledgeAuthor = 'you',
  ): Promise<KnowledgeUnzipResult> {
    if (!bytesMatch('zip', zipBytes))
      throw new HttpError(415, 'unsupported_type', 'That isn’t a zip file.')
    const folder = cleanSegments(folderInput).join('/')
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'score-unzip-'))
    try {
      const zipFile = path.join(scratch, 'input.zip')
      await fs.writeFile(zipFile, zipBytes, { mode: 0o600 })
      const out = await runWorker(
        { op: 'zip-extract', file: zipFile, outDir: path.join(scratch, 'out'), limits: ZIP_LIMITS },
        ZIP_TIMEOUT_MS,
      )
      if (!out.ok) throw zipFailure(out)
      if (!('files' in out))
        throw new HttpError(415, 'unsupported_type', 'Couldn’t read that zip file.')
      const skipped = [...out.skipped]
      // Only one extracted file is in memory at a time: each is checked here, then dropped, and read again from the
      // scratch folder when it is placed (an unzip can total 1 GB).
      const prepared: Unpacked[] = []
      const taken = new Set<string>()
      for (const file of out.files) {
        try {
          const item = await this.prepare(`${folder}/${file.path}`, await fs.readFile(file.file))
          if (taken.has(item.path.toLowerCase())) {
            skipped.push({ path: file.path, reason: 'name clashes with another file in the zip' })
            continue
          }
          taken.add(item.path.toLowerCase())
          prepared.push({
            path: item.path,
            file: file.file,
            facts: item.kind === 'document' ? withoutBytes(item) : null,
          })
        } catch (error) {
          skipped.push({
            path: file.path,
            reason: error instanceof HttpError ? error.message : 'could not be read',
          })
        }
      }
      const written = await this.vault.runLocked(async () => {
        const clashes: Array<{ path: string; mtime: string; size: number }> = []
        for (const item of prepared) {
          const clash = await this.existing(item.path)
          if (clash) clashes.push(clash)
        }
        if (clashes.length > 0 && onConflict === 'ask') throw this.exists(clashes)
        // What replace was chosen over: each file is published only while it still has this version.
        const replacing = new Map<string, string | null>()
        if (onConflict === 'replace')
          for (const clash of clashes) replacing.set(clash.path, await this.versionOf(clash.path))
        if (clashes.length > 0 && onConflict === 'keep') {
          // Renamed files must also avoid every other incoming name and each other.
          const reserved = new Set(prepared.map((item) => item.path.toLowerCase()))
          for (const item of prepared) {
            const clash = clashes.find((candidate) => candidate.path === item.path)
            if (!clash) continue
            item.path = await this.freeName(item.path, reserved)
            reserved.add(item.path.toLowerCase())
          }
        }
        await this.vault.commitOutside()
        const committed: string[] = []
        const done: Unpacked[] = []
        for (const item of prepared) {
          const { stat } = await this.vault.lookup(item.path.split('/'))
          if (stat && !stat.isFile()) {
            skipped.push({ path: item.path, reason: 'a folder has that name' })
            continue
          }
          const expect = { hash: replacing.get(item.path) ?? null }
          try {
            if (item.facts) {
              const bytes = await fs.readFile(item.file)
              await this.place({ ...item.facts, path: item.path, bytes }, author, expect, committed)
            } else {
              const abs = await this.vault.prepareParent(item.path)
              await this.vault.atomicWrite(abs, await fs.readFile(item.file, 'utf8'), expect)
              await this.vault.indexNote(item.path, author)
              committed.push(item.path)
            }
          } catch (error) {
            // Something else took or changed the name after the check: it stays as it is, the rest carries on.
            if (error instanceof HttpError && (error.status === 409 || error.status === 412)) {
              skipped.push({
                path: item.path,
                reason: 'it changed while the files were being added',
              })
              continue
            }
            throw error
          }
          done.push(item)
        }
        let history: KnowledgeHistoryStatus = 'not_versioned'
        if (committed.length > 0)
          history = (await this.vault.commitPaths(committed, `Unzipped ${zipName}`, author)).history
        for (const item of done.slice(0, MAX_EVENTS))
          await this.vault.publishChange({ path: item.path, kind: 'written', to: null, by: author })
        return { paths: done.map((item) => item.path), history }
      })
      return { folder, written: written.paths, skipped, history: written.history }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true })
    }
  }
}
