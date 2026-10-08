import { z } from 'zod'
import type { AgentDetail, MemoryItem, MemoryPage } from '@score/contract'

// Request shapes for the Team tabs; the response bodies live in packages/contract (§8).
const NoNul = (value: string) => !value.includes('\0')
const Token = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,199}$/)
  .refine(NoNul)

export const SetModelSchema = z.object({ model: Token, provider: Token.optional() }).strict()
export const InstallSkillSchema = z.object({ name: Token }).strict()
export const PatchSkillSchema = z.object({ enabled: z.boolean() }).strict()
export const PatchToolSchema = z.object({ enabled: z.boolean() }).strict()
export const AddMemorySchema = z
  .object({
    text: z
      .string()
      .refine(NoNul)
      .refine((value) => value.trim().length > 0)
      .refine((value) => value.length <= 2000)
      // The store splits entries on a section sign line, so one entry may not contain it.
      .refine((value) => !/(^|\n)\s*§\s*(\n|$)/.test(value)),
  })
  .strict()
export const SkillNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
export const ToolIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
export const MemoryIdSchema = z.string().regex(/^[mu]-[0-9a-f]{12}$/)
export const HubQuerySchema = z.string().refine(NoNul).max(200)
export const MemoryQuerySchema = z.object({
  q: z.string().refine(NoNul).max(200).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
})

export type AgentTool = AgentDetail['tools'][number]

export const MEMORY_PAGE_SIZE = 20
export const MEMORY_DETAIL_ITEMS = 5

/** Filters and pages a newest-first memory list; the cursor is an offset. */
export function pageMemory(
  all: readonly MemoryItem[],
  query: z.infer<typeof MemoryQuerySchema>,
  writable = true,
): MemoryPage {
  const needle = query.q?.trim().toLowerCase()
  const matches = needle ? all.filter((item) => item.text.toLowerCase().includes(needle)) : all
  const start = Number(query.cursor ?? 0)
  const items = matches.slice(start, start + MEMORY_PAGE_SIZE)
  return {
    items: [...items],
    nextCursor: start + MEMORY_PAGE_SIZE < matches.length ? String(start + MEMORY_PAGE_SIZE) : null,
    ...(writable ? {} : { writable: false }),
  }
}
