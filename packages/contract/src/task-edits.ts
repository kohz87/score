import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// 3.27.0 (owner: "i cannot create, edit or remove tasks?", mock-up approved): the Tasks page makes and edits Hermes
// tasks again. Remove is Archive (`POST /api/tasks/:taskId/actions { action: 'archive' }`): Hermes has no hard delete.
const TaskText = z.string().refine((value) => !value.includes('\0'), 'No null characters.')

/** `POST /api/tasks`: a new Hermes task (the same as `/assign @agent <title>` in a chat). */
export const TaskCreateRequestSchema = z
  .object({
    title: TaskText.pipe(z.string().trim().min(1).max(1000)),
    body: TaskText.pipe(z.string().max(32000)).optional(),
    assignee: AgentIdSchema.optional(),
    /** The chat the task belongs to (kept by Score); omitted = none. */
    roomId: z.string().min(1).max(64).optional(),
    /** `now`: it goes straight to Working (`start`); `later` (default): Planned. */
    start: z.enum(['now', 'later']).optional(),
  })
  .strict()
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>

/** `PATCH /api/tasks/:taskId`: change the title, the description or who does it. */
export const TaskPatchRequestSchema = z
  .object({
    title: TaskText.pipe(z.string().trim().min(1).max(1000)).optional(),
    body: TaskText.pipe(z.string().max(32000)).optional(),
    assignee: AgentIdSchema.optional(),
  })
  .strict()
  .refine((req) => Object.keys(req).length > 0, 'Change at least one thing.')
export type TaskPatchRequest = z.infer<typeof TaskPatchRequestSchema>
