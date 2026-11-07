import { type ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const run = promisify(execFile)

export function waitFor<T>(child: ChildProcess, type: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error(`timed out waiting for ${type}`))
    }, timeoutMs)
    const onMessage = (message: { type: string; message?: string }) => {
      if (message.type === 'error') {
        finish()
        reject(new Error(message.message))
      } else if (message.type === type) {
        finish()
        resolve(message as T)
      }
    }
    const onExit = () => {
      finish()
      reject(new Error(`server exited before ${type}`))
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}
