const UNIT_NAME = /^score-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.service$/
const MAX_UNIT_NAME = 200

export function validateUnitName(name: string): boolean {
  return name.length <= MAX_UNIT_NAME && UNIT_NAME.test(name)
}

/** The unit-name prefix of an installation: `score-<installation8>-c-` (lead answer, part 3). */
export function unitPrefix(installationId: string): string {
  return `score-${installationId.slice(0, 8)}-c-`
}

/**
 * `score-<installation8>-c-<launch id without dashes>.service`. Launch ids are server-minted UUIDv4s, so the name is
 * globally unique per launch and never reused (design 6b). The exact name is stored in the launch row and the journal
 * record and is never derived again from other fields. `prefix` is a test seam (the opt-in suite uses `score-test-…`).
 */
export function unitNameFor(installationId: string, launchId: string, prefix?: string): string {
  const name = `${prefix ?? unitPrefix(installationId)}${launchId.replaceAll(/[^A-Za-z0-9]/g, '')}.service`
  if (!validateUnitName(name)) throw new Error('cannot build a valid unit name')
  return name
}

/** Whether a unit name carries this installation's prefix (necessary, not sufficient: the journal decides ownership). */
export function hasInstallationPrefix(
  name: string,
  installationId: string,
  prefix?: string,
): boolean {
  return validateUnitName(name) && name.startsWith(prefix ?? unitPrefix(installationId))
}
