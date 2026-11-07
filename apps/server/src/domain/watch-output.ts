export const OUTPUT_BYTES = 64 * 1024

/** Keep the last `maxBytes` of UTF-8 text without splitting a character. */
export function tailBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false }
  const kept: string[] = []
  let size = 0
  for (const char of Array.from(text).reverse()) {
    size += Buffer.byteLength(char)
    if (size > maxBytes) break
    kept.push(char)
  }
  return { text: kept.reverse().join(''), cut: true }
}
