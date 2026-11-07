import { JobSchema, type Job } from '@score/contract'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { SetURLSearchParams } from 'react-router'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStream } from '../../data/query-client.ts'
import { beginJobUndo } from './job-undo.ts'
import { jobLifecycleError } from './RoomMenus.tsx'
import { changeCachedJob } from './room-queries.ts'

type LifecycleNotice = {
  job: Job
  text: string
  stillWorking: boolean
}

export function useRoomJobLifecycle({
  queryClient,
  allJobs,
  params,
  setParams,
  locationState,
  externalDeletedNotice,
  severalJobs,
  selectedJob,
  selectJob,
  setDeletingJob,
}: {
  queryClient: QueryClient
  allJobs: Job[]
  params: URLSearchParams
  setParams: SetURLSearchParams
  locationState: unknown
  externalDeletedNotice: boolean
  severalJobs: boolean
  selectedJob: string
  selectJob: (jobId: string) => void
  setDeletingJob: Dispatch<SetStateAction<Job | null>>
}) {
  const [lifecycleBusy, setLifecycleBusy] = useState<string | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<LifecycleNotice | null>(null)
  const allJobsRef = useRef(allJobs)
  const stream = useStream()

  useEffect(() => {
    allJobsRef.current = allJobs
  }, [allJobs])

  // A delete from another tab (or another device) takes the open job with it; this tab returns to All and says why.
  useEffect(
    () =>
      stream.subscribe((event) => {
        if (event.type !== 'job.deleted') return
        const open = params.get('job')
        if (open !== event.data.id) return
        const next = new URLSearchParams(params)
        next.delete('job')
        next.delete('message')
        // The Workbench and Results views of that job go with it.
        next.delete('work')
        next.delete('file')
        setParams(next, { replace: true, state: locationState })
        if (!externalDeletedNotice)
          setLifecycleNotice({
            job: allJobsRef.current.find((job) => job.id === event.data.id) ?? {
              id: event.data.id,
              roomId: event.data.roomId,
              title: 'Deleted job',
              state: 'open',
              holderAgentId: null,
              isDefault: false,
              exchangeBudget: 8,
              jobTurnLimit: 40,
              unread: 0,
              activeAgents: [],
              lastMessageAt: null,
              messageCount: 0,
              summary: null,
              source: null,
              reportBack: null,
              spendCapUsd: null,
              recipe: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
            text: 'That job was deleted.',
            stillWorking: false,
          })
      }),
    [externalDeletedNotice, locationState, params, setParams, stream],
  )

  async function changeJobState(job: Job, action: 'close' | 'reopen') {
    setLifecycleBusy(job.id)
    setLifecycleNotice(null)
    try {
      const changed = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(job.id)}/${action}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: '{}',
        }),
      )
      changeCachedJob(queryClient, changed, 'upsert')
      if (action === 'close') {
        // An older chat keeps the closed job's divider. With one job per chat there is none, so the closed job stays
        // picked: its past-job bar carries the menu the notice points to.
        if (severalJobs) {
          if (selectedJob === job.id) selectJob('all')
        } else selectJob(changed.id)
        setLifecycleNotice({
          job: changed,
          text: `Closed “${changed.title}”. Reopen it from its menu.`,
          stillWorking: false,
        })
      } else {
        selectJob(changed.id)
        setLifecycleNotice({
          job: changed,
          text: `Reopened “${changed.title}”.`,
          stillWorking: false,
        })
      }
    } catch (failure) {
      const problem = jobLifecycleError(failure, action)
      setLifecycleNotice({ job, text: problem.text, stillWorking: problem.stillWorking })
    } finally {
      setLifecycleBusy(null)
    }
  }

  async function stopForLifecycle(job: Job) {
    setLifecycleBusy(job.id)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/stop`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      setLifecycleNotice({
        job,
        text: 'Stop sent. Close or delete the job again once it has stopped.',
        stillWorking: false,
      })
    } catch (failure) {
      const problem = jobLifecycleError(failure, 'close')
      setLifecycleNotice({ job, text: problem.text, stillWorking: true })
    } finally {
      setLifecycleBusy(null)
    }
  }

  async function reopenForComposer(jobId: string) {
    const reopened = JobSchema.parse(
      await apiFetch(`jobs/${encodeURIComponent(jobId)}/reopen`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      }),
    )
    changeCachedJob(queryClient, reopened, 'upsert')
    // The composer retries the message after this resolves. Keep this job selected so
    // the retry still goes into it instead of falling back to the room's default thread.
    if (selectedJob !== jobId) selectJob(jobId)
  }

  function jobDeleted(job: Job) {
    setDeletingJob(null)
    changeCachedJob(queryClient, job, 'delete')
    if (selectedJob === job.id) selectJob('all')
    beginJobUndo(queryClient, job)
  }

  return {
    lifecycleBusy,
    lifecycleNotice,
    setLifecycleNotice,
    changeJobState,
    stopForLifecycle,
    reopenForComposer,
    jobDeleted,
  }
}
