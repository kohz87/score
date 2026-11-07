import { existsSync, readFileSync } from 'node:fs'

const REQUIRED = [
  'launch',
  'generation',
  'token',
  'socket',
  'receiptDir',
  'command',
  'graceMs',
  'deadline',
]

export function loadSpec(path) {
  const spec = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of REQUIRED) if (spec[key] === undefined) throw new Error(`spec: missing ${key}`)
  const c = spec.command
  if (typeof c?.file !== 'string' || !c.file.startsWith('/') || !Array.isArray(c.args))
    throw new Error('spec: bad command')
  if (!Number.isFinite(spec.graceMs) || spec.graceMs < 0) throw new Error('spec: bad graceMs')
  if (!existsSync(spec.receiptDir)) throw new Error('spec: receipt directory missing')
  return spec
}
