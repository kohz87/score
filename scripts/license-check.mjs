#!/usr/bin/env node
// Fails if any installed npm dependency (direct or transitive, prod or dev) has a license outside
// the policy in AGENTS.md: MIT, Apache-2.0, BSD-2/3-Clause, ISC; SIL OFL only for font packages.
// Exceptions must be approved by the project owner and listed in license-exceptions.json.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { FONT_SCOPES, permitted } from './license-policy.mjs'

const exceptions = JSON.parse(
  readFileSync(new URL('../license-exceptions.json', import.meta.url), 'utf8'),
)
const approved = new Map(exceptions.approved.map((e) => [`${e.name}@${e.version}`, e]))

// -r: every workspace package (apps/web, apps/server, packages/*), not just the root importer, which alone missed half
// the tree until 2026-10-09.
const raw = execFileSync('pnpm', ['-r', 'licenses', 'list', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const byLicense = JSON.parse(raw)

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
