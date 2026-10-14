import { z } from 'zod'

/** `GET /api/about` (API-CONTRACT § 10, decision 79). */
export const AboutSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1).nullable(),
  schema: z.int().nonnegative(),
  contract: z.int().positive(),
  hermes: z.object({ version: z.string().min(1) }).nullable(),
  node: z.string().min(1),
  mode: z.enum(['live', 'fake']),
  repository: z.url({ protocol: /^https$/ }),
  checkout: z.string().min(1),
})
export type About = z.infer<typeof AboutSchema>

export const UpdateCheckStatusSchema = z.enum([
  'up_to_date',
  'update_available',
  'ahead',
  'unavailable',
])

/** `POST /api/about/update-check`: only ever answers a click, never runs by itself. */
export const UpdateCheckSchema = z.object({
  checkedAt: z.iso.datetime(),
  current: z.string().min(1),
  status: UpdateCheckStatusSchema,
  latest: z
    .object({
      version: z.string().min(1),
      tag: z.string().min(1),
      url: z.url({ protocol: /^https$/ }),
      changelogUrl: z.url({ protocol: /^https$/ }),
    })
    .nullable(),
  message: z.string().min(1),
})
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>
