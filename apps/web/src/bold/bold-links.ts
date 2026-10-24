// PLAN 11.5: Workbench links carry the job and the tab the person chose. The Workbench screen itself lands in 11.6b;
// keeping the parameter names here means Search, Results and that screen cannot drift apart.
export type WorkbenchTab = 'code' | 'screen' | 'draft' | 'workbench'

export function workbenchHref(jobId: string, tab: WorkbenchTab): string {
  const params = new URLSearchParams({ job: jobId, work: tab })
  return `/b?${params.toString()}`
}
