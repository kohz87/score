import type { CostSource } from '@score/contract'
import { useEffect, useState } from 'react'
import { SCHEDULES, type Ask, type When } from './bold-start-job.ts'
import type { BusyStart } from './room/BusyDialog.tsx'
import type { RecipeChoice, Result, StartJobOptions } from './start-job-types.ts'
import type { StartJobRefs } from './use-start-job-refs.ts'

export function useStartJobState(options: StartJobOptions | undefined, refs: StartJobRefs) {
  const { authInputRef, dialogRef, returnFocusRef } = refs
  const [chatPick, setChatPick] = useState<string | null>(options?.pickChat ? '' : null)
  const [leftRoomId, setLeftRoomId] = useState<string | null>(options?.exceptRoomId ?? null)
  const [busyStart, setBusyStart] = useState<BusyStart | null>(null)

  const [what, setWhat] = useState('')
  // When the dialog opened: a deadline before it is already past (read once, not on every render).
  const [openedAt] = useState(() => Date.now())
  const [recipe, setRecipe] = useState<RecipeChoice>({ kind: 'lead' })
  const [when, setWhen] = useState<When>('once')
  const [ask, setAsk] = useState<Ask>('risky')
  const [turns, setTurns] = useState(8)
  const [cap, setCap] = useState(5)
  // 3.27.0: a lead-decides run keeps going until the person stops it; that choice needs a spend cap.
  const [untilStoppedChoice, setUntilStopped] = useState(true)
  const [deadlineEnabled, setDeadlineEnabled] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [schedule, setSchedule] = useState<string>(SCHEDULES[0].label)
  const [triggerApp, setTriggerApp] = useState('Another app')
  const [triggerName, setTriggerName] = useState('')
  const [unknownSpend, setUnknownSpend] = useState<'pause' | 'continue'>('pause')
  const [unknownCost, setUnknownCost] = useState<CostSource[]>([])
  const [ack, setAck] = useState(false)
  // The policy ids the person accepted the reach of, as one key: a changed id is not covered and is asked again.
  const [reachAcceptedKey, setReachAcceptedKey] = useState<string | null>(null)
  // Recipe options under "More options"; blank/null = the preflight's own defaults (the classic start dialog's).
  // Raw text, so an empty field is invalid rather than 0; null = untouched = the preflight's default.
  const [codingSteps, setCodingSteps] = useState<string | null>(null)
  const [quotaFloor, setQuotaFloor] = useState('')
  const [concurrent, setConcurrent] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<string | null>(null)
  const [saveRecipe, setSaveRecipe] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowed, setAllowed] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  // One key for one start attempt; a retry of the job step replays instead of making a second run or job.
  const [planner, setPlanner] = useState<string | null>(null)
  // 3.13: the oracle. The folder stays derived (the first chosen coding agent's workspace) until the person types one.
  const [checkCommand, setCheckCommand] = useState('')
  // 3.14: the advisor; '' = none. Derived below so a lead change to the same agent clears it.
  const [advisorPick, setAdvisorPick] = useState('')
  // 3.15: who the advisor helps. On call (default) also lets a Claude Code worker ask it while it works.
  const [checkFolder, setCheckFolder] = useState<string | null>(null)
  // 3.13.1: who answers votes (named agents, never the lead; Score counts the answers).
  const [voterPick, setVoterPick] = useState<string[]>([])
  // 3.13.1: raw text; null = follows the suggestion until the person types.
  const [launchesText, setLaunchesText] = useState<string | null>(null)
  // 3.14: the automatic votes before each step (they need voters).
  const [autoVote, setAutoVote] = useState(false)
  const [autoVoteK, setAutoVoteK] = useState('3')
  // 3.16: who decides a split vote among the voters: the lead (default) or you.
  const [helperSplit, setHelperSplit] = useState<'lead' | 'person'>('lead')
  // SA.3: the lead's own subagents for this job. `subagentsAt` null = the lead's limit (capped at four).
  const [subagentsOn, setSubagentsOn] = useState(true)
  const [subagentsAt, setSubagentsAt] = useState<number | null>(null)
  const [subagentsTotal, setSubagentsTotal] = useState('20')
  const [checkEachStep, setCheckEachStep] = useState(false)
  const [checkMinutes, setCheckMinutes] = useState('10')
  const [authNeeded, setAuthNeeded] = useState(false)
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  useEffect(() => {
    if (!authNeeded) return
    const input = authInputRef.current
    input?.focus()
    // jsdom has no scrollIntoView.
    input?.scrollIntoView?.({ block: 'center' })
  }, [authNeeded, authInputRef])

  useEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      const opener = returnFocusRef.current
      if (opener?.isConnected) opener.focus()
    }
  }, [dialogRef, returnFocusRef])

  return {
    chatPick,
    setChatPick,
    leftRoomId,
    setLeftRoomId,
    busyStart,
    setBusyStart,
    what,
    setWhat,
    openedAt,
    recipe,
    setRecipe,
    when,
    setWhen,
    ask,
    setAsk,
    turns,
    setTurns,
    cap,
    setCap,
    untilStoppedChoice,
    setUntilStopped,
    deadlineEnabled,
    setDeadlineEnabled,
    deadline,
    setDeadline,
    schedule,
    setSchedule,
    triggerApp,
    setTriggerApp,
    triggerName,
    setTriggerName,
    unknownSpend,
    setUnknownSpend,
    unknownCost,
    setUnknownCost,
    ack,
    setAck,
    reachAcceptedKey,
    setReachAcceptedKey,
    codingSteps,
    setCodingSteps,
    quotaFloor,
    setQuotaFloor,
    concurrent,
    setConcurrent,
    estimate,
    setEstimate,
    saveRecipe,
    setSaveRecipe,
    inputs,
    setInputs,
    allowed,
    setAllowed,
    busy,
    setBusy,
    error,
    setError,
    result,
    setResult,
    saveWarning,
    setSaveWarning,
    dirty,
    setDirty,
    confirmClose,
    setConfirmClose,
    planner,
    setPlanner,
    checkCommand,
    setCheckCommand,
    advisorPick,
    setAdvisorPick,
    checkFolder,
    setCheckFolder,
    voterPick,
    setVoterPick,
    launchesText,
    setLaunchesText,
    autoVote,
    setAutoVote,
    autoVoteK,
    setAutoVoteK,
    helperSplit,
    setHelperSplit,
    subagentsOn,
    setSubagentsOn,
    subagentsAt,
    setSubagentsAt,
    subagentsTotal,
    setSubagentsTotal,
    checkEachStep,
    setCheckEachStep,
    checkMinutes,
    setCheckMinutes,
    authNeeded,
    setAuthNeeded,
    authPassword,
    setAuthPassword,
    authError,
    setAuthError,
    authBusy,
    setAuthBusy,
  }
}

export type StartJobState = ReturnType<typeof useStartJobState>
