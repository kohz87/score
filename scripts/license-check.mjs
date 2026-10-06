#!/usr/bin/env node
// Fails if any installed npm dependency (direct or transitive, prod or dev) has a license outside
// the policy in AGENTS.md: MIT, Apache-2.0, BSD, ISC; SIL OFL only for font packages.
// Exceptions must be approved by the project owner and listed in license-exceptions.json.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ALLOWED = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'])
const FONT_LICENSES = new Set(['OFL-1.1'])
const FONT_SCOPES = ['@fontsource/']

const exceptions = JSON.parse(
  readFileSync(new URL('../license-exceptions.json', import.meta.url), 'utf8'),
)
const approved = new Map(exceptions.approved.map((e) => [`${e.name}@${e.version}`, e]))

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const byLicense = JSON.parse(raw)

/** True if an SPDX expression is satisfiable with allowed ids (OR = any branch, AND = all parts). */
function permitted(expr, isFont) {
  const ok = (id) => ALLOWED.has(id) || (isFont && FONT_LICENSES.has(id))
  const clean = String(expr).replace(/[()]/g, ' ').trim()
  return clean
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((id) => ok(id.trim())))
}

const violations = []
let count = 0
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const pkg of pkgs) {
    const versions = pkg.versions ?? (pkg.version ? [pkg.version] : ['?'])
    for (const version of versions) {
      count++
      const isFont = FONT_SCOPES.some((s) => pkg.name.startsWith(s))
      if (permitted(license, isFont)) continue
      if (approved.has(`${pkg.name}@${version}`)) continue
      violations.push(`${pkg.name}@${version}: ${license}`)
    }
  }
}

if (violations.length) {
  console.error(
    `License check FAILED: ${violations.length} of ${count} packages are outside policy:`,
  )
  for (const v of violations.sort()) console.error(`  - ${v}`)
  console.error('Replace them, or get owner approval and add them to license-exceptions.json.')
  process.exit(1)
}
console.log(`License check passed: ${count} packages, all within policy.`)
