import { z } from 'zod'

const Envelope = z.object({ type: z.string() }).loose()
const ThreadStarted = z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) })
const TurnCompleted = z.object({
  type: z.literal('turn.completed'),
  usage: z
    .object({
      input_tokens: z.number().finite().nonnegative().optional(),
      cached_input_tokens: z.number().finite().nonnegative().optional(),
      output_tokens: z.number().finite().nonnegative().optional(),
    })
    .loose()
    .optional(),
})
const TurnFailed = z.object({
  type: z.literal('turn.failed'),
  error: z.object({ message: z.string() }).partial().optional(),
})
const ItemEvent = z.object({
  type: z.enum(['item.started', 'item.updated', 'item.completed']),
  item: z.object({ id: z.string().min(1), type: z.string() }).loose(),
})
const CommandItem = z.object({
  command: z.string(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().int().nullish(),
  status: z.string().optional(),
})
const MessageItem = z.object({ text: z.string() })
const FileItem = z.object({
  changes: z.array(
    z.object({ path: z.string().min(1), kind: z.enum(['add', 'delete', 'update']) }),
  ),
  status: z.string().optional(),
})
const McpItem = z.object({
  server: z.string().optional(),
  tool: z.string(),
  status: z.string().optional(),
})
const SearchItem = z.object({ query: z.string() })

// Records Score knows it can ignore, named explicitly (FW #5): a notice that carries no turn content. Everything else
// that isn't understood is loss for the whole attempt, because it could have been the one that mattered.
const IGNORABLE_RECORDS = new Set(['turn.started'])
// The one `error` record that is only a notice: Codex telling the person it is retrying a dropped stream. It must be
// exactly this shape, short, and arrive before the turn ended (FV #3); any other error record reports a failure.
const ErrorNotice = z.object({ type: z.literal('error'), message: z.string().max(300) }).strict()
const IGNORABLE_ITEMS = new Set(['todo_list'])

export {
  CommandItem,
  Envelope,
  ErrorNotice,
  FileItem,
  IGNORABLE_ITEMS,
  IGNORABLE_RECORDS,
  ItemEvent,
  McpItem,
  MessageItem,
  SearchItem,
  ThreadStarted,
  TurnCompleted,
  TurnFailed,
}
