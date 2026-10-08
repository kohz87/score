import type { ImageReader } from '../port.ts'

// Raw bytes per message; base64 (x4/3) plus text stays under the gateway's 10 MB body limit.
export const IMAGE_BUDGET_BYTES = 6 * 1024 * 1024

/** Hermes `input` for a run: the text alone, or one user message with the text and `image_url` parts. */
export function buildRunInput(
  text: string,
  mediaIds: readonly string[],
  read: ImageReader | undefined,
): string | unknown[] {
  const parts: unknown[] = []
  let used = 0
  let tooLarge = 0
  let missing = 0
  for (const id of mediaIds) {
    const media = read?.(id) ?? null
    if (!media) {
      missing++
      continue
    }
    if (used + media.bytes.length > IMAGE_BUDGET_BYTES) {
      tooLarge++
      continue
    }
    used += media.bytes.length
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`,
      },
    })
  }
  const notes = [
    tooLarge &&
      `${tooLarge} attached image${tooLarge === 1 ? '' : 's'} could not be sent: too large`,
    missing &&
      `${missing} attached image${missing === 1 ? '' : 's'} could not be sent: no longer available`,
  ].filter(Boolean)
  const note = notes.length ? `\n\n(${notes.join('; ')})` : ''
  if (!parts.length && !note) return text
  if (!parts.length) return `${text}${note}`
  return [{ role: 'user', content: [{ type: 'text', text: `${text}${note}` }, ...parts] }]
}
