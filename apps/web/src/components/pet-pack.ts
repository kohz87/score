import type { PetActivity, PetPack } from '@score/contract'

/** Where one file of an agent's pet pack is served from; a new pack is a new revision, so the URL never changes meaning. */
export function petPackUrl(agentId: string, activity: PetActivity, rev: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/pack/${activity}?rev=${encodeURIComponent(rev)}`
}

export function packActivities(pack: Pick<PetPack, 'activities'>): ReadonlySet<PetActivity> {
  return new Set(pack.activities)
}
