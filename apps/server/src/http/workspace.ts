import {
  WorkspaceBinarySchema,
  WorkspaceCreateRequestSchema,
  WorkspaceInfoSchema,
  WorkspaceMoveRequestSchema,
  WorkspaceRootRequestSchema,
  WorkspaceTreeSchema,
  WorkspaceWriteRequestSchema,
  type WorkspaceInfo,
} from '@score/contract'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import {
  checkRoot,
  defaultRootPolicy,
  type RootPolicy,
  WorkspaceError,
} from '../workspace/policy.ts'
import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, Workspace } from '../workspace/workspace.ts'

const AgentParams = z.object({ agentId: z.string().min(1).max(256) })
const PathQuery = z.object({ path: z.string().max(4096).default('') })
const FileQuery = PathQuery.extend({ download: z.enum(['1']).optional() })
const DeleteQuery = PathQuery.extend({ recursive: z.enum(['1']).optional() })

// Team › agent › Workspace (contract §8). The agent's working folder comes from the adapter; everything about
// paths and files lives in ../workspace/ and knows nothing about Hermes. Every route is human-guarded, reads
// included: a workspace can hold secrets.
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  port: HermesPort,
  config: Pick<Config, 'home' | 'hermesHome'>,
  policy: RootPolicy = defaultRootPolicy([config.home, config.hermesHome]),
): void {
  async function info(agentId: string): Promise<WorkspaceInfo & { cwd: string | null }> {
    const { cwd, backend } = await port.readWorkspaceConfig(agentId)
    if (backend !== null && backend.trim() !== '' && backend.trim().toLowerCase() !== 'local')
      return {
        root: null,
        available: false,
        reason: `This agent works on a remote terminal (${backend.replace(/[^\w.-]/g, '').slice(0, 40)}), so its files are not on this machine`,
        cwd,
      }
    if (cwd === null || cwd.trim() === '' || cwd.trim() === '.')
      return {
        root: null,
        available: false,
        reason: 'No working folder is set for this agent',
        cwd,
      }
    const checked = await checkRoot(cwd, policy)
    if (!checked.ok) return { root: null, available: false, reason: checked.reason, cwd }
    return { root: checked.real, available: true, reason: null, cwd }
  }

  async function open(request: FastifyRequest, agentId: string): Promise<Workspace> {
    const state = await info(agentId)
    if (!state.available || state.root === null)
      throw new HttpError(
        409,
        'workspace_unavailable',
        state.reason ?? 'The workspace is unavailable',
      )
    return Workspace.open(state.root, policy, (event) =>
      // Path, size and operation only; never content.
      request.log.info({ agentId, workspace: event }, 'workspace write'),
    )
  }

  // Domain errors keep their status and code; anything else is the usual 500.
  function wrap(work: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await work(request, reply)
      } catch (error) {
        if (error instanceof WorkspaceError)
          throw new HttpError(error.status, error.code, error.message, error.details)
        throw error
      }
    }
  }

  // The raw-body parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_request, body, done) => done(null, body),
    )
    // onRequest: before any body is read, so an unpaired caller can't make the server buffer megabytes.
    scope.addHook('onRequest', async (request) => {
      if (!app.pairing.isPaired(request.headers.cookie))
        throw new HttpError(401, 'not_paired', 'Pair this browser to make human decisions')
    })
    const base = '/api/agents/:agentId/workspace'

    scope.get(
      base,
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const { root, available, reason } = await info(agentId)
        return WorkspaceInfoSchema.parse({ root, available, reason })
      }),
    )

    scope.put(
      `${base}/root`,
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path } = WorkspaceRootRequestSchema.parse(request.body)
        const current = await port.readWorkspaceConfig(agentId)
        if (current.backend !== null && current.backend.trim().toLowerCase() !== 'local')
          throw new HttpError(409, 'workspace_unavailable', 'This agent works on a remote terminal')
        const checked = await checkRoot(path, policy)
        if (!checked.ok) throw new HttpError(409, 'workspace_unavailable', checked.reason)
        await port.setWorkspaceCwd(agentId, checked.real)
        request.log.info(
          { agentId, workspace: { op: 'set-root', path: checked.real } },
          'workspace root',
        )
        return WorkspaceInfoSchema.parse({ root: checked.real, available: true, reason: null })
      }),
    )

    scope.get(
      `${base}/tree`,
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path } = PathQuery.parse(request.query)
        const workspace = await open(request, agentId)
        return WorkspaceTreeSchema.parse({ entries: await workspace.list(path) })
      }),
    )

    scope.get(
      `${base}/file`,
      wrap(async (request, reply) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path, download } = FileQuery.parse(request.query)
        const workspace = await open(request, agentId)
        const result = await workspace.read(path, download ? { download: true } : {})
        void reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Cache-Control', 'no-store')
        switch (result.kind) {
          case 'text':
            return reply
              .header('Content-Type', 'text/plain; charset=utf-8')
              .header('ETag', `"${result.etag}"`)
              .send(result.content)
          case 'raw':
            return reply
              .header('Content-Type', result.contentType)
              .header('Content-Disposition', 'inline')
              .header('ETag', `"${result.etag}"`)
              .send(result.bytes)
          case 'download':
            return reply
              .header('Content-Type', 'application/octet-stream')
              .header(
                'Content-Disposition',
                `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
              )
              .send(result.bytes)
          case 'binary':
            return reply.send(
              WorkspaceBinarySchema.parse({
                binary: true,
                size: result.size,
                reason: result.reason,
              }),
            )
        }
      }),
    )

    scope.put(
      `${base}/file`,
      // The JSON-escaped form of 1 MiB of text can be several times larger than the text.
      { bodyLimit: 6 * MAX_TEXT_BYTES },
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path } = PathQuery.parse(request.query)
        const body = WorkspaceWriteRequestSchema.parse(request.body)
        const workspace = await open(request, agentId)
        const { etag } = await workspace.write(path, body.content, body.etag)
        return { etag }
      }),
    )

    scope.post(
      `${base}/entries`,
      wrap(async (request, reply) => {
        const { agentId } = AgentParams.parse(request.params)
        const body = WorkspaceCreateRequestSchema.parse(request.body)
        const workspace = await open(request, agentId)
        await workspace.create(body.path, body.kind)
        return reply.code(201).send({})
      }),
    )
    scope.post(
      `${base}/move`,
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const body = WorkspaceMoveRequestSchema.parse(request.body)
        const workspace = await open(request, agentId)
        await workspace.move(body.from, body.to)
        return {}
      }),
    )
    scope.delete(
      `${base}/entries`,
      wrap(async (request) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path, recursive } = DeleteQuery.parse(request.query)
        const workspace = await open(request, agentId)
        await workspace.remove(path, recursive === '1')
        return {}
      }),
    )
    scope.post(
      `${base}/upload`,
      { bodyLimit: MAX_UPLOAD_BYTES },
      wrap(async (request, reply) => {
        const { agentId } = AgentParams.parse(request.params)
        const { path } = PathQuery.parse(request.query)
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'Send the file as application/octet-stream')
        const workspace = await open(request, agentId)
        const { size } = await workspace.upload(path, request.body)
        return reply.code(201).send({ path, size })
      }),
    )
  })
}
