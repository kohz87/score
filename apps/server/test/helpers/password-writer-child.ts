// Child process for security-password-processes.test.ts. Run with Node's type stripping/transform.
import fs from 'node:fs'
import { applyHostPassword, withPasswordLock } from '../../src/auth/password-store.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'

const [role, home, password, current, ready, go] = process.argv.slice(2) as string[]
if (role === 'hold') {
  // Holds the lock until `go` appears (args: hold <home> <ready> <go>); the test may SIGKILL it while it holds.
  await withPasswordLock(home!, async () => {
    fs.writeFileSync(password!, 'x')
    while (!fs.existsSync(current!)) await new Promise((resolve) => setTimeout(resolve, 20))
  })
  console.log('hold-done')
} else if (role === 'host') {
  await applyHostPassword(home!, password!)
  console.log('host-done')
} else {
  // The browser path, paused under the lock right after its final comparison.
  const sp = new SecurityPassword(home!, Date.now, async () => {
    fs.writeFileSync(ready!, 'x')
    while (!fs.existsSync(go!)) await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await sp.set(password, current)
  console.log('browser-done')
}
