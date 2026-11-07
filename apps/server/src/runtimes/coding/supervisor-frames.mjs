import { procStart } from './supervisor-protocol.mjs'

export function createFrameHandler(ctx) {
  return function handleFrame(line) {
    let f
    try {
      f = JSON.parse(line)
    } catch {
      return ctx.onLoss()
    }
    if (f === null || typeof f !== 'object') return ctx.onLoss()
    switch (f.t) {
      case 'welcome':
        if (ctx.phase !== 'connecting') return
        try {
          ctx.payloadDir = ctx.cgroup.prepare()
        } catch {
          ctx.send({ t: 'error', code: 'cgroup' })
          ctx.phase = 'ended'
          ctx.finish(ctx.EXIT.failed)
          return
        }
        ctx.phase = 'waiting-go'
        // `deps.self` lets tests that run the supervisor inside the test process report a distinct identity.
        ctx.send({
          t: 'ready',
          pid: ctx.deps.self?.pid ?? process.pid,
          start: ctx.deps.self?.start ?? procStart(process.pid),
          cgroup: ctx.cgroup.path,
        })
        return
      case 'reject':
        ctx.stopCause = 'rejected'
        ctx.phase = 'ended'
        ctx.finish(ctx.EXIT.rejected)
        return
      case 'go':
        if (ctx.phase !== 'waiting-go') return
        // The expiry is absolute and checked right before the spawn (7.7b A2): a `go` that was delayed past it (a slow
        // commit, a stalled socket) must not start the CLI, whatever the control loop's tick has noticed so far.
        if (ctx.now() >= ctx.spec.deadline) return ctx.expireBeforeSpawn()
        ctx.startCli()
        return
      case 'cancel':
        if (ctx.phase === 'waiting-go' || ctx.phase === 'connecting') {
          ctx.stopCause = 'cancel'
          ctx.endWithoutRun()
        } else ctx.requestStop('cancel', true)
        return
      case 'stop':
        ctx.requestStop(
          typeof f.cause === 'string' && f.cause.length <= 64 ? f.cause : 'stop',
          true,
        )
        return
      case 'ack-end':
        if (ctx.phase === 'ended' && ctx.childExited) {
          if (ctx.stoppedAfterEnd) {
            ctx.finish(ctx.EXIT.failed)
            return
          }
          // The final receipt: written after `ack-end` was READ, before the exit. It is evidence that the acknowledgment was
          // consumed and nothing more: a failed publication is removed again, but removal can fail too, so Score never
          // takes the receipt (or its `durable` flag) for a clean exit; that comes from the unit's own metadata (FU #1).
          const body = { launch: ctx.spec.launch, generation: ctx.spec.generation, at: ctx.now() }
          try {
            try {
              ctx.writeReceipt(ctx.spec.receiptDir, 'acked.json', body, ctx.deps.receiptIo)
            } catch (error) {
              // An earlier writer's name: take it over and make it durable below (or fail).
              if (error?.code !== 'EEXIST') throw error
            }
            ctx.replaceReceipt(
              ctx.spec.receiptDir,
              'acked.json',
              { ...body, durable: true },
              ctx.deps.receiptIo,
            )
          } catch {
            try {
              ctx.unlinkSync(ctx.join(ctx.spec.receiptDir, 'acked.json'))
              ctx.syncDirectory(ctx.spec.receiptDir)
            } catch {
              // nothing more can be done; the exit below is non-zero
            }
            ctx.finish(ctx.EXIT.failed)
            return
          }
          ctx.finish(ctx.EXIT.ok)
        }
        return
      default:
        return
    }
  }
}
