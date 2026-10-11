// Sets (or resets) Score's security password from the host terminal: `scripts/score password`.
// Same format as apps/server/src/auth/security-password.ts (salted scrypt, N=2^15, r=8, p=1, 32-byte key).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyHostPassword } from '../apps/server/src/auth/password-store.ts'

const home = process.env.SCORE_HOME || join(homedir(), '.score')

function ask(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Run this in a terminal.'))
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(value)
        }
        if (char === '\u0003') {
          process.stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f') value = value.slice(0, -1)
        else value += char
      }
    }
    process.stdin.on('data', onData)
  })
}

const password = await ask('New security password (8+ characters): ')
if (password.length < 8 || password.length > 256) {
  console.error('Use 8 to 256 characters.')
  process.exit(1)
}
if ((await ask('Again: ')) !== password) {
  console.error('The two entries differ. Nothing changed.')
  process.exit(1)
}
// Hash, then publish under the lock the server's setter takes too (a browser change can be in flight), provenance
// first and credential second: see apps/server/src/auth/password-store.ts.
try {
  const path = await applyHostPassword(home, password)
  console.log(`Security password set (${path}). It applies at once; no restart needed.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
