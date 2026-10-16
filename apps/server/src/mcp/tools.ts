import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  OrchAskArgsSchema,
  OrchAssignArgsSchema,
  OrchCancelArgsSchema,
  OrchFinishArgsSchema,
  OrchNoteArgsSchema,
  OrchPlanArgsSchema,
  OrchReceiptArgsSchema,
  OrchRequestApprovalArgsSchema,
  type Message,
} from '@score/contract'
import { assertRoomFree } from '../domain/orchestration/ownership.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import type { ToolName } from '../domain/orchestration/commands.ts'
import { assertAgentAdmits } from '../domain/agent-lifecycle.ts'
import { readRoom, roomIds, roomRow, storeMessage } from '../domain/rooms.ts'
import { rewindingRooms } from '../domain/room-rewinding.ts'
import { projectedTasks, taskSummary } from '../domain/tasks.ts'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { KnowledgeAgentApi } from '../knowledge/agent-api.ts'
import { redact } from '../redact.ts'
import type { McpAccessStore } from './access.ts'

export interface McpToolDeps {
  db: ScoreDb
  access: McpAccessStore
  ingest: Pick<Ingest, 'submit'>
  port: Pick<HermesPort, 'taskAction'>
  knowledge?: KnowledgeAgentApi
  /** The orchestration executor (PLAN 7.5a); without it the `orch.*` tools are not offered. */
  orchestrator?: Pick<Orchestrator, 'handleTool'>
  clock?: () => number
}

const MAX_LIST = 50
const POST_BYTES = 8 * 1024
const COMMENT_BYTES = 1500
const VIA = '[via MCP]'

// Zod's max() counts UTF-16 units; the documented limits are bytes.
function checkText(value: string, bytes: number): void {
  if (value.includes('\0'))
    throw new HttpError(400, 'bad_request', 'Text can’t contain null bytes.')
  if (Buffer.byteLength(value, 'utf8') > bytes)
    throw new HttpError(413, 'payload_too_large', `Text may be at most ${bytes} bytes`)
}

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
})
const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
})

/**
 * One MCP server per request, bound to the agent the bearer token named (contract §13). The agent id is a closure
 * value: no tool takes an agent argument, so a prompt-injected agent cannot act as another one. Every call re-checks the
 * switches, so turning access off takes effect on the next call.
 */
export function createMcpServer(
  agentId: string,
  deps: McpToolDeps,
  /** Brackets each tool run so the route can hold its concurrency permit until the work is done; `undefined` = refused. */
  begin: () => (() => void) | undefined = () => () => undefined,
): McpServer {
  const { db, access, ingest, port, knowledge, orchestrator, clock = Date.now } = deps
  const server = new McpServer({ name: 'score', version: '1' })

  function guarded<A>(write: boolean, run: (args: A) => Promise<unknown> | unknown) {
    return async (args: A): Promise<CallToolResult> => {
      const end = begin()
      if (!end) return failure('aborted: the MCP request ended before this tool could start')
      try {
        const state = access.get(agentId)
        if (!state.enabled)
          throw new HttpError(403, 'mcp_off', 'MCP access is turned off for this agent in Score')
        if (write && !state.writesEnabled)
          throw new HttpError(
            403,
            'mcp_writes_off',
            'Writing through MCP is turned off for this agent in Score. Read tools still work.',
          )
        return text(await run(args))
      } catch (error) {
        if (error instanceof HttpError) return failure(`${error.code}: ${error.message}`)
        throw error
      } finally {
        end()
      }
    }
  }

  const memberRoom = (sqlite: Parameters<Parameters<ScoreDb['read']>[0]>[0], roomId: string) => {
    const room = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
    // Unknown rooms and rooms the agent is not in look the same.
    if (!room.members.includes(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
    return room
  }

  server.registerTool(
    'rooms.list',
    {
      description:
        'List the Score rooms you are in, with a short preview of the latest message in each.',
    },
    guarded(false, () =>
      db.read((sqlite) => ({
        rooms: roomIds(sqlite)
          .map((id) => readRoom(sqlite, id, roomRow(sqlite, id).updated_at))
          .filter((room) => room.members.includes(agentId) && room.archived !== true)
          .slice(0, MAX_LIST)
          .map((room) => {
            const last = sqlite
              .prepare(
                'SELECT author_kind, author_agent_id, parts FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
              )
              .get(room.id) as
              { author_kind: string; author_agent_id: string | null; parts: string } | undefined
            const parts = last ? (JSON.parse(last.parts) as { kind: string; text?: string }[]) : []
            return {
              id: room.id,
              name: room.name,
              kind: room.kind,
              members: room.members,
              lastMessage: last
                ? {
                    from: last.author_kind === 'agent' ? last.author_agent_id : 'owner',
                    preview: redact(parts.find((part) => part.kind === 'text')?.text ?? '').slice(
                      0,
                      300,
                    ),
                  }
                : null,
            }
          }),
      })),
    ),
  )

  server.registerTool(
    'rooms.post',
    {
      description:
        'Post a message into a Score room you are in. It appears as written by you, tagged "via MCP". It does not wake other agents, and @mentions in it are not routed.',
      inputSchema: {
        roomId: z.string().min(1).max(200),
        text: z.string().min(1).max(POST_BYTES),
      },
    },
    guarded(true, async ({ roomId, text: body }: { roomId: string; text: string }) => {
      checkText(body, POST_BYTES)
      db.read((sqlite) => {
        assertRoomFree(sqlite, roomId, 'mcp.rooms.post')
        memberRoom(sqlite, roomId)
        assertAgentAdmits(sqlite, agentId)
      })
      if (rewindingRooms.has(roomId))
        throw new HttpError(409, 'conflict', 'This room is being rewound. Try again in a moment.')
      const release = access.reservePost(agentId, 'rooms.post')
      const id = randomUUID()
      try {
        await ingest.submit({
          source: 'mcp',
          identity: randomUUID(),
          apply({ sqlite, now }) {
            // Checked again in the writing transaction: membership, a rewind or the agent's lifecycle may have
            // changed while this waited in the queue.
            assertRoomFree(sqlite, roomId, 'mcp.rooms.post')
            memberRoom(sqlite, roomId)
            assertAgentAdmits(sqlite, agentId)
            if (rewindingRooms.has(roomId))
              throw new HttpError(
                409,
                'conflict',
                'This room is being rewound. Try again in a moment.',
              )
            const message: Message = {
              id,
              roomId,
              author: { kind: 'agent', agentId },
              to: [],
              parts: [{ kind: 'text', text: redact(body), via: 'mcp' }],
              createdAt: now,
              streaming: false,
              refs: [],
            }
            return storeMessage(sqlite, message, now)
          },
        })
      } catch (error) {
        release()
        throw error
      }
      return { messageId: id }
    }),
  )

  server.registerTool(
    'tasks.list',
    {
      description: 'List the Score tasks assigned to you or waiting for your review.',
      inputSchema: { limit: z.int().min(1).max(MAX_LIST).optional() },
    },
    guarded(false, ({ limit }: { limit?: number | undefined }) =>
      db.read((sqlite) => ({
        tasks: projectedTasks(sqlite, clock())
          .filter((task) => task.assignee === agentId || task.reviewer === agentId)
          .map(taskSummary)
          .slice(0, limit ?? 20),
      })),
    ),
  )

  server.registerTool(
    'tasks.comment',
    {
      description:
        'Add a comment to a Score task assigned to you or waiting for your review. The comment is tagged "via MCP".',
      inputSchema: {
        taskId: z.string().min(1).max(256),
        text: z.string().min(1).max(1500),
      },
    },
    guarded(true, async ({ taskId, text: body }: { taskId: string; text: string }) => {
      checkText(body, COMMENT_BYTES)
      const mine = db.read((sqlite) => {
        assertAgentAdmits(sqlite, agentId)
        return projectedTasks(sqlite, clock()).some(
          (task) => task.id === taskId && (task.assignee === agentId || task.reviewer === agentId),
        )
      })
      if (!mine) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
      const release = access.reservePost(agentId, 'tasks.comment')
      try {
        // Hermes records the comment's author as Score, so the tag names the agent.
        await port.taskAction({
          taskId,
          action: 'comment',
          text: `${VIA} ${redact(body)}`,
          author: agentId,
        })
      } catch (error) {
        release()
        throw error
      }
      return { ok: true }
    }),
  )

  if (orchestrator) {
    // `orch.*` (contract §14): they need the MCP access switch and an active per-turn capability for this agent, and not
    // the writes switch (v3.1). Identity is still the token's agent; the capability binds the lead attempt.
    const orch = (name: ToolName, description: string, shape: Record<string, z.ZodType>) =>
      server.registerTool(
        name,
        { description, inputSchema: shape },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
          const state = access.get(agentId)
          if (!state.enabled)
            return failure('mcp_off: MCP access is turned off for this agent in Score')
          const outcome = await orchestrator.handleTool(agentId, name, args)
          if (outcome.kind === 'unauthorized') return failure(`unauthorized: ${outcome.message}`)
          const receipt = outcome.receipt
          return { ...text(receipt), ...(receipt.status === 'ok' ? {} : { isError: true }) }
        },
      )
    const withoutBase = (shape: Record<string, z.ZodType>) => shape
    orch(
      'orch.plan',
      'Record or replace the visible plan of the orchestration run. Executes nothing. Needs the capability from your turn input and a commandId.',
      withoutBase(OrchPlanArgsSchema.shape),
    )
    orch(
      'orch.assign',
      'Queue a step for a team agent. Score validates it against the run limits, budget and gates; the step starts when its "after" steps succeeded. Use replaces to retry or replace a failed or stopped step.',
      withoutBase(OrchAssignArgsSchema.shape),
    )
    orch(
      'orch.cancel',
      'Stop a step. If it has already started, Score stops it and starts nothing new in the run until it has ended or the person decides otherwise.',
      withoutBase(OrchCancelArgsSchema.shape),
    )
    orch(
      'orch.ask',
      'Ask the person a question. Their answer arrives as data in your next turn; it never grants permission.',
      withoutBase(OrchAskArgsSchema.shape),
    )
    orch(
      'orch.requestApproval',
      'Under the lead-asks policy: ask the person to approve a queued step before it starts.',
      withoutBase(OrchRequestApprovalArgsSchema.shape),
    )
    orch(
      'orch.note',
      'Post a progress line into the run room.',
      withoutBase(OrchNoteArgsSchema.shape),
    )
    orch(
      'orch.finish',
      'Finish the run: stops new work, retires queued steps and waits for started ones to end.',
      withoutBase(OrchFinishArgsSchema.shape),
    )
    orch(
      'orch.receipt',
      'Look up the stored receipt of an earlier command of this turn by its commandId (use after a reply was lost).',
      withoutBase(OrchReceiptArgsSchema.shape),
    )
  }

  if (knowledge) {
    server.registerTool(
      'knowledge.search',
      {
        description:
          'Search the shared Knowledge in Score: Markdown notes and the text of uploaded documents (PDF, DOCX, CSV, JSON, HTML). Hits say whether they are a note or a document.',
        inputSchema: {
          query: z.string().min(1).max(500),
          limit: z.int().min(1).max(20).optional(),
        },
      },
      guarded(false, ({ query, limit }: { query: string; limit?: number | undefined }) =>
        knowledge.search(agentId, query, limit ?? 10),
      ),
    )
    server.registerTool(
      'knowledge.read',
      {
        description:
          'Read one note from Score’s Knowledge by path. Returns its etag, needed to update it. Embedded images appear as numbered placeholders like [image 2: alt, 69 B] (the note’s 2nd image). For an uploaded document (e.g. .pdf, .docx, .csv) it returns the extracted text, read-only, with a notice when the text is missing or was cut.',
        inputSchema: { path: z.string().min(1).max(1024) },
      },
      guarded(false, ({ path }: { path: string }) => knowledge.read(agentId, path)),
    )
    server.registerTool(
      'knowledge.write',
      {
        description:
          'Create or replace a note in Score’s Knowledge. Pass expectedEtag from knowledge.read to replace a note, or null to create a new one. Copy each [image 2: alt, 69 B] placeholder exactly as you read it, number included, to keep that image; delete one to remove its image; you can’t add images. The reply’s history field says whether the save reached history: committed or unchanged, not_versioned (the folder is Git-ignored: no earlier version), failed or git_unavailable (saved, history not updated).',
        inputSchema: {
          path: z.string().min(1).max(1024),
          body: z.string().max(256 * 1024),
          expectedEtag: z.string().min(1).max(200).nullable().optional(),
        },
      },
      guarded(
        true,
        ({
          path,
          body,
          expectedEtag,
        }: {
          path: string
          body: string
          expectedEtag?: string | null | undefined
        }) => knowledge.write(agentId, path, body, expectedEtag ?? null),
      ),
    )
  }
  return server
}
