export const waitChildExit = (child, childExited, ms) =>
  new Promise((resolve) => {
    if (!child || childExited) return resolve(true)
    const t = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })

export const signalTree = (child, childExited, sig) => {
  // The CLI is our direct child and its own group leader (detached); the group stays ours until the leader is reaped.
  if (!child || childExited || child.pid === undefined) return
  try {
    process.kill(-child.pid, sig)
  } catch {
    // already gone
  }
}
