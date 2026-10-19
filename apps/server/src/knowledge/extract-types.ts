export interface ZipLimits {
  maxEntries: number
  maxTotalBytes: number
  maxNoteBytes: number
  /** Per extracted file that is not a note. */
  maxFileBytes: number
  /** Compressed-to-uncompressed ratio per entry. */
  maxRatio: number
  /** Entries up to this size are not held to the ratio (tiny files compress absurdly well legitimately). */
  ratioFloorBytes: number
}

export interface ZipItem {
  path: string
  size: number
  action: 'extract' | 'skip'
  reason: string | null
}

export type WorkerRequest =
  | { op: 'text'; kind: 'pdf' | 'docx' | 'html'; bytes: Uint8Array; maxBytes: number }
  // Zips come as a file the worker reads itself: the archive is never copied through the worker's start-up data.
  | { op: 'zip-list'; file: string; limits: ZipLimits }
  | { op: 'zip-extract'; file: string; outDir: string; limits: ZipLimits }

export type WorkerResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: true; entries: ZipItem[]; more: boolean }
  | {
      ok: true
      files: Array<{ path: string; size: number; file: string }>
      skipped: Array<{ path: string; reason: string }>
    }
  | { ok: false; limit: boolean; message: string }
