import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Message } from '@score/contract'
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
  clock?: () => number
}

const MAX_LIST = 50
const POST_BYTES = 8 * 1024
const COMMENT_PREFIX_ROOM = 'via MCP'

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
export function createMcpServer(agentId: string, deps: McpToolDeps): McpServer {
  const { db, access, ingest, port, knowledge, clock = Date.now } = deps
  const server = new McpServer({ name: 'score', version: '1' })

  function guarded<A>(write: boolean, run: (args: A) => Promise<unknown> | unknown) {
    return async (args: A): Promise<CallToolResult> => {
      try {
        const state = access.get(agentId)
        if (!state.enabled)
          throw new HttpError(403, 'mcp_off', 'MCP access is turned off for this agent in Score')
        if (write && !state.writesEnabled)
          throw new HttpError(
            403,
            'mcp_writes_off',
            'Writing through MCP is turned off for this agent in Score (read tools still work)',
          )
        return text(await run(args))
      } catch (error) {
        if (error instanceof HttpError) return failure(`${error.code}: ${error.message}`)
        throw error
      }
    }
  }

  const memberRoom = (sqlite: Parameters<Parameters<ScoreDb['read']>[0]>[0], roomId: string) => {
    const room = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
    // Unknown rooms and rooms the agent is not in look the same.
    if (!room.members.includes(agentId)) throw new HttpError(404, 'not_found', 'Unknown room')
    return room
  }

  server.registerTool(
    'rooms.list',
    {
      description:
        'List the Score chat rooms you are a member of, with a short preview of the latest message.',
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
                'SELECT author_kind, author_agent_id, parts FROM messages WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
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
        'Post a note into a Score room you are a member of. It appears as written by you, tagged "via MCP". It does not wake other agents and @mentions in it are not routed.',
      inputSchema: {
        roomId: z.string().min(1).max(200),
        text: z.string().min(1).max(POST_BYTES),
      },
    },
    guarded(true, async ({ roomId, text: body }: { roomId: string; text: string }) => {
      if (body.includes('\0')) throw new HttpError(400, 'bad_request', 'Text may not contain NUL')
      db.read((sqlite) => {
        memberRoom(sqlite, roomId)
        assertAgentAdmits(sqlite, agentId)
      })
      if (rewindingRooms.has(roomId))
        throw new HttpError(409, 'conflict', 'This room is being rewound; try again in a moment')
      const release = access.reservePost(agentId, 'rooms.post')
      const id = randomUUID()
      try {
        await ingest.submit({
          source: 'mcp',
          identity: randomUUID(),
          apply({ sqlite, now }) {
            // Checked again in the writing transaction: membership may have changed meanwhile.
            memberRoom(sqlite, roomId)
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
      if (body.includes('\0')) throw new HttpError(400, 'bad_request', 'Text may not contain NUL')
      const mine = db.read((sqlite) => {
        assertAgentAdmits(sqlite, agentId)
        return projectedTasks(sqlite, clock()).some(
          (task) => task.id === taskId && (task.assignee === agentId || task.reviewer === agentId),
        )
      })
      if (!mine) throw new HttpError(404, 'not_found', 'Unknown task')
      const release = access.reservePost(agentId, 'tasks.comment')
      try {
        // Hermes records the comment's author as Score, so the tag names the agent.
        await port.taskAction({
          taskId,
          action: 'comment',
          text: `[${COMMENT_PREFIX_ROOM}: ${agentId}] ${redact(body)}`,
        })
      } catch (error) {
        release()
        throw error
      }
      return { ok: true }
    }),
  )

  if (knowledge) {
    server.registerTool(
      'knowledge.search',
      {
        description: 'Search the shared Score knowledge vault of Markdown notes.',
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
          'Read one note from the Score knowledge vault by path. Returns its etag, needed to update it.',
        inputSchema: { path: z.string().min(1).max(1024) },
      },
      guarded(false, ({ path }: { path: string }) => knowledge.read(agentId, path)),
    )
    server.registerTool(
      'knowledge.write',
      {
        description:
          'Create or replace a note in the Score knowledge vault. Pass expectedEtag from knowledge.read to replace a note, or null to create a new one.',
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
