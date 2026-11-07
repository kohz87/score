export function createDrain(ctx) {
  return async function maybeDrained() {
    // Cleanup runs once the leader has exited, whether or not the pipes have reached EOF: a survivor that keeps the
    // CLI's stdout/stderr open must not delay killing the payload (review #1).
    if (ctx.draining || !ctx.childExited) return
    ctx.draining = true
    ctx.phase = 'draining'
    const graceDeadline = ctx.now() + ctx.grace
    let emptySince = null
    for (;;) {
      const state = ctx.cgroup.payloadState()
      if (state === 'empty' && ctx.cgroup.unitAlone()) {
        if (ctx.eof.stdout && ctx.eof.stderr) break
        // Nothing left in the payload can hold a pipe open; if EOF still has not arrived, close our ends.
        emptySince ??= ctx.now()
        if (ctx.now() - emptySince >= ctx.grace)
          for (const name of ['stdout', 'stderr'])
            if (!ctx.eof[name]) {
              ctx.forced[name] = true
              ctx.child?.[name]?.destroy()
            }
      } else {
        emptySince = null
        if (!ctx.survivorsKilled && (ctx.stopCause !== null || ctx.now() >= graceDeadline)) {
          // A survivor outlived the CLI (a daemon, a setsid job): the cgroup is the only thing that still reaches it.
          // Retried while the kill is unavailable or has not emptied the cgroup.
          ctx.survivorsKilled = ctx.cgroup.killPayload()
        } else if (ctx.survivorsKilled && ctx.now() >= graceDeadline + ctx.grace) {
          ctx.cgroup.killPayload()
        }
      }
      await ctx.sleep(ctx.deps.pollMs ?? ctx.spec.pollMs ?? 50)
      if (ctx.finished) return
    }
    try {
      ctx.writeReceipt(ctx.spec.receiptDir, 'ended.json', {
        launch: ctx.spec.launch,
        generation: ctx.spec.generation,
        at: ctx.now(),
        code: ctx.exitInfo?.code ?? null,
        signal: ctx.exitInfo?.signal ?? null,
        stopCause: ctx.stopCause,
        survivorsKilled: ctx.survivorsKilled,
      })
    } catch {
      ctx.send({ t: 'error', code: 'receipt' })
      ctx.finish(ctx.EXIT.failed)
      return
    }
    ctx.phase = 'ended'
    ctx.send({ t: 'end', survivorsKilled: ctx.survivorsKilled, stopCause: ctx.stopCause })
  }
}
