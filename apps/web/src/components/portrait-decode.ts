import { portraitCrop, type PortraitCrop } from './portrait-crop.ts'

export type DecodedPortrait = {
  /** An object URL of the still portrait, already cropped and scaled down. */
  url: string
  crop: PortraitCrop
  /** The idle frame's size, for placing the animated file the same way. */
  width: number
  height: number
}

/** Large enough for the biggest portrait (44px) at 2x; one small image per agent. */
const OUTPUT = 128

/** Decodes the first frame of an idle file and cuts the portrait from it. Browser only (canvas); throws on any failure. */
export async function decodePortrait(src: string): Promise<DecodedPortrait> {
  const image = new Image()
  image.src = src
  await image.decode()
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width === 0 || height === 0) throw new Error('empty image')
  const frame = document.createElement('canvas')
  frame.width = width
  frame.height = height
  const context = frame.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no canvas')
  context.drawImage(image, 0, 0)
  const crop = portraitCrop(context.getImageData(0, 0, width, height).data, width, height)
  const out = document.createElement('canvas')
  out.width = OUTPUT
  out.height = OUTPUT
  const target = out.getContext('2d')
  if (!target) throw new Error('no canvas')
  target.drawImage(frame, crop.x, crop.y, crop.side, crop.side, 0, 0, OUTPUT, OUTPUT)
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not encode')
  return { url: URL.createObjectURL(blob), crop, width, height }
}
