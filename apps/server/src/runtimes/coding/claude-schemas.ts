import { z } from 'zod'

const ContentBlock = z.object({ type: z.string() }).loose()
const TextBlock = z.object({ type: z.literal('text'), text: z.string() })
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() })
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
})
const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
})
// 3.14.1 (decision 151): Claude Code's own advisor (`--advisor`, 2.1.312, real capture 2026-10-28). A consult is a server tool
// call named `advisor` with no input, answered in the same message by an `advisor_tool_result` whose advice is encrypted for
// the model (`advisor_redacted_result`): Score sees that the worker asked, never what the advisor said.
const AdvisorUseBlock = z.object({
  type: z.literal('server_tool_use'),
  id: z.string().min(1),
  name: z.literal('advisor'),
})
const AdvisorResultBlock = z.object({
  type: z.literal('advisor_tool_result'),
  tool_use_id: z.string().min(1),
  content: z.object({ type: z.string().min(1) }).loose(),
})
const Envelope = z.object({ type: z.string() }).loose()
const InitEvent = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  model: z.string().optional(),
})
const MessageEvent = z.object({
  type: z.enum(['assistant', 'user']),
  message: z.object({ content: z.union([z.string(), z.array(ContentBlock)]) }).loose(),
})
const ResultEvent = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().finite().nonnegative().optional(),
  ttft_ms: z.number().finite().nonnegative().optional(),
  usage: z
    .object({
      input_tokens: z.number().finite().nonnegative().optional(),
      output_tokens: z.number().finite().nonnegative().optional(),
      cache_creation_input_tokens: z.number().finite().nonnegative().optional(),
      cache_read_input_tokens: z.number().finite().nonnegative().optional(),
    })
    .loose()
    .optional(),
})

// Records and blocks Score knows it can ignore, named explicitly (FW #5): notices and partial stream events that carry
// neither the answer nor a failure. Anything else Score can't understand is loss for the whole attempt (it could have
// been the final result or the error that contradicts an earlier success).
const IGNORABLE_RECORDS = new Set(['stream_event', 'rate_limit_event', 'keep_alive'])
// System records that are notices (hooks, a retried request, status). Validated: a known subtype that reports an error,
// an unknown subtype, or any system record after the result could be the failure that contradicts the verdict (FV #3).
const IGNORABLE_SYSTEM = new Set([
  'hook_started',
  'hook_response',
  // Sent by Claude Code 2.x right after init, before the answer (seen in a real read-only turn, 2026-10-13).
  'commands_changed',
  'hook_progress',
  'api_retry',
  'status',
  'compact_boundary',
  // 3.8.2 (owner: opus55's reviews all "failed"): print-mode notices in Claude Code 2.1.311's own code. A thinking-token
  // estimate, a tool call the permission rules refused (the turn goes on; the result still decides), and sub-agent
  // bookkeeping. None carries the answer or the turn's failure.
  'thinking_tokens',
  'permission_denied',
  'background_tasks_changed',
])

const SystemNotice = z.object({
  type: z.literal('system'),
  subtype: z.string().min(1),
  is_error: z.boolean().optional(),
})
// Sub-agent records (Claude Code 2.1.302, real capture 2026-10-17). Exactly the captured shapes; a record that does not
// match falls through to the system-notice rule and is loss. They describe the sub-agent only, never the turn.
const Count = z.number().finite().nonnegative()
const SubUsage = z.object({ total_tokens: Count, tool_uses: Count, duration_ms: Count }).loose()
const TaskStarted = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  description: z.string(),
  subagent_type: z.string().optional(),
  is_error: z.boolean().optional(),
})
const TaskProgress = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_progress'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  usage: SubUsage,
  is_error: z.boolean().optional(),
})
const TaskUpdated = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string().min(1),
  patch: z.object({ status: z.string().min(1).optional() }).loose(),
  is_error: z.boolean().optional(),
})
const TaskNotification = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  status: z.string().min(1),
  usage: SubUsage.optional(),
  is_error: z.boolean().optional(),
})
const IGNORABLE_BLOCKS = new Set(['image', 'redacted_thinking', 'document'])

export {
  AdvisorResultBlock,
  AdvisorUseBlock,
  ContentBlock,
  Envelope,
  IGNORABLE_BLOCKS,
  IGNORABLE_RECORDS,
  IGNORABLE_SYSTEM,
  InitEvent,
  MessageEvent,
  ResultEvent,
  SystemNotice,
  TaskNotification,
  TaskProgress,
  TaskStarted,
  TaskUpdated,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
}
