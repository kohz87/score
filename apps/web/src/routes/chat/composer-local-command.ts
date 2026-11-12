import type { AgentSummary } from '@score/contract'
import type { QueryClient } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import type { Notice } from './composer-types.ts'
import {
  codingUsageSummary,
  fetchAgentContext,
  parseLocalCommand,
  usageSummary,
} from './context-meter.ts'
import { buildUsageCard } from './usage-card.ts'
import { codingAgentQuotaQuery } from '../team/QuotaMeters.tsx'
import { isCodingRuntime } from '../team/quota-view.ts'

type LocalCommand = NonNullable<ReturnType<typeof parseLocalCommand>>

export function createLocalCommandRunner({
  subject,
  subjectAgent,
  setText,
  setCaret,
  setNotice,
  onCompress,
  roomMode,
  hasFooter,
  setCompactSubject,
  setCompactSignal,
  queryClient,
}: {
  subject: string | null
  subjectAgent: AgentSummary | undefined
  setText: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setNotice: Dispatch<SetStateAction<Notice | null>>
  onCompress?: () => void
  roomMode: boolean
  hasFooter: boolean
  setCompactSubject: Dispatch<SetStateAction<string | null>>
  setCompactSignal: Dispatch<SetStateAction<number>>
  queryClient: QueryClient
}) {
  // /compress, /usage and /model <name> are answered here (PLAN 5.25); other commands go to the server as before.
  return async function runLocalCommand(command: LocalCommand) {
    const name = subjectAgent?.name ?? subject
    setNotice(null)
    if (!subject || !name) {
      setNotice({ kind: 'error', text: 'Choose who this is for first: add someone to “To”.' })
      return
    }
    setText('')
    setCaret(0)
    try {
      if (command.kind === 'compress') {
        // The ring's details open on the compaction confirmation (PLAN 5.36).
        if (onCompress) onCompress()
        else if (roomMode && hasFooter) {
          // The chat's footer carries the meter (3.22.0): it opens on the compaction confirmation.
          setCompactSubject(subject)
          setCompactSignal((value) => value + 1)
        } else if (roomMode) {
          // The team room's composer has no ring: say where compaction is, instead of clearing the command silently.
          setText('/compress')
          setNotice({
            kind: 'info',
            text: 'Compact from a one-to-one chat or a job: the context ring sits beside its message box.',
          })
        } else {
          setCompactSubject(subject)
          setCompactSignal((value) => value + 1)
        }
      } else if (command.kind === 'usage') {
        const runtime = subjectAgent?.runtime
        if (isCodingRuntime(runtime)) {
          const [context, quota] = await Promise.all([
            fetchAgentContext(subject),
            // A reading under a minute old is reused; only an older one is fetched again.
            queryClient
              .fetchQuery({ ...codingAgentQuotaQuery(subject), staleTime: 60_000 })
              .catch(() => undefined),
          ])
          setNotice({
            kind: 'usage',
            text: codingUsageSummary(name, context, quota, runtime),
            card: buildUsageCard(subjectAgent, name, context, quota, runtime),
          })
        } else {
          setNotice({ kind: 'info', text: usageSummary(name, await fetchAgentContext(subject)) })
        }
      } else {
        await apiFetch(`agents/${encodeURIComponent(subject)}/model`, {
          method: 'PUT',
          body: JSON.stringify({ model: command.model }),
        })
        void queryClient.invalidateQueries({ queryKey: ['chat', 'context'] })
        setNotice({ kind: 'info', text: `${name} now uses ${command.model}.` })
      }
    } catch (error) {
      setText(`/${command.kind}${command.kind === 'model' ? ` ${command.model}` : ''}`)
      setNotice({
        kind: 'error',
        text:
          error instanceof ApiError && error.status === 400
            ? `${command.kind === 'model' ? command.model : 'That'} isn’t available for ${name}.`
            : 'That command failed. Try again.',
      })
    }
  }
}
