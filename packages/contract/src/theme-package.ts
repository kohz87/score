// The rules a theme package must meet, shared by the Customizer's reader (apps/web) and the installing reader
// (apps/server) so that what the browser previews is what the server accepts. Pure: bytes in, verdicts out; no Node or
// browser APIs. Gate findings #1 and #10 (Phase 9 re-gate).

export class ThemePackageError extends Error {}

const EXTRA_UNICODE_PATH = 0x7075

/**
 * Walks the extra-field records of a zip header (`id`, `size`, data). A record that runs past the field is malformed.
 * The Info-ZIP Unicode Path record (0x7075) replaces the entry's name for readers that honour it, so a previewing
 * reader and an installing reader could see different names; no package may carry one. Other records (timestamps,
 * Unicode comments, unknown ones) don't change what a file is called and are ignored.
 */
export function extraFieldProblem(extra: Uint8Array): string | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let at = 0
  while (at < extra.length) {
    if (at + 4 > extra.length) return 'a header has a malformed extra field'
    const id = view.getUint16(at, true)
    const size = view.getUint16(at + 2, true)
    if (at + 4 + size > extra.length) return 'a header has a malformed extra field'
    if (id === EXTRA_UNICODE_PATH) return 'a header carries a second, Unicode name for the file'
    at += 4 + size
  }
  return null
}
