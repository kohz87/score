import { useId, type ReactNode, type RefObject } from 'react'
import { CloseIcon } from './BoldIcons.tsx'
import { StartJobChatPick, StartJobRecipe, StartJobWhat } from './BoldStartJobFields.tsx'
import { HelperFields, StartJobLaunches } from './BoldStartJobHelperFields.tsx'
import { CheckFields } from './BoldStartJobCheckFields.tsx'
import {
  LimitsFields,
  MoreOptionsFields,
  StartJobInputs,
  StartJobUnknownCost,
} from './BoldStartJobLimitFields.tsx'
import {
  AskChoices,
  StartJobAdvisor,
  StartJobLead,
  StartJobWhen,
} from './BoldStartJobPlanFields.tsx'
import {
  AuthFields,
  ChecklistContent,
  ChecklistRows,
  CloseConfirm,
  CopyButton,
  StartJobActions,
  StartJobResult,
  StartJobScheduled,
} from './BoldStartJobParts.tsx'
import { ReloadMcp } from './ReloadMcp.tsx'
import { BusyDialog } from './room/BusyDialog.tsx'
import type { Result, StartJobOptions } from './start-job-types.ts'
import { useStartJobRefs } from './use-start-job-refs.ts'
import { useStartJobView, type StartJobView } from './use-start-job-view.ts'
import './bold-start.css'

export { StartJobContext, useStartJob } from './start-job-context.ts'
export type { StartJobOptions } from './start-job-types.ts'

/** The Start a job dialog (PLAN 11.10c), rebuilt from the prototype's mStart and the trigger wizard. */
export function BoldStartJob({
  onClose,
  options,
}: {
  onClose: () => void
  options?: StartJobOptions
}) {
  const refs = useStartJobRefs()
  const view = useStartJobView(onClose, options, refs)
  const titleId = useId()
  const { authInputRef, attemptKeyRef, closeButtonRef, dialogRef, stoppedForStartRef } = refs

  return (
    <div
      className="bold-start-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) view.requestClose()
      }}
    >
      <div
        ref={dialogRef}
        className="dialog bold-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-protected="block"
        data-decision
        onKeyDown={view.onDialogKeyDown}
      >
        <div className="row">
          <h2 id={titleId} className="grow start-title">
            Start a job
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={view.requestClose}
          >
            <CloseIcon />
          </button>
        </div>

        {view.confirmClose && (
          <CloseConfirm
            secret={view.result?.kind === 'trigger'}
            onKeep={() => view.setConfirmClose(false)}
            onClose={onClose}
          />
        )}

        {view.busyStart && (
          <BusyDialog
            busy={view.busyStart}
            onStopAndStart={async () => {
              if (!view.busyStart) return
              stoppedForStartRef.current = view.busyStart.running.id
              view.setBusyStart(null)
              attemptKeyRef.current = null
              await view.start()
            }}
            onAnotherChat={() => {
              // The work stays as typed; only the chat changes. The busy chat is not offered again.
              view.setLeftRoomId(view.startRoom?.id ?? null)
              view.setChatPick('')
              view.setBusyStart(null)
              attemptKeyRef.current = null
            }}
            onCancel={() => view.setBusyStart(null)}
          />
        )}

        {view.result ? (
          view.result.kind === 'trigger' ? (
            <TriggerResult result={view.result} onClose={onClose} />
          ) : (
            <StartJobResult result={view.result} saveWarning={view.saveWarning} onClose={onClose} />
          )
        ) : (
          <>
            {view.chatPick !== null && <StartJobChatPick view={view} />}
            {view.showWhat && <StartJobWhat view={view} />}
            {view.showRecipe && <StartJobRecipe view={view} />}

            {view.isLead && <StartJobLead view={view} />}

            <div
              className={`start-controls start-controls--${!view.nowOnce ? 1 : view.showAsk ? 3 : 2} start-when`}
            >
              <StartJobWhen view={view} />

              {view.showAsk && <AskSection view={view} />}

              {view.isLead && <StartJobAdvisor view={view} />}

              {view.isLead && <HelpersSection view={view} />}

              {view.isLead && view.launchesInUse && <StartJobLaunches view={view} />}

              {view.isLead && <CheckSection view={view} />}

              {view.nowOnce && <LimitsSection view={view} />}
            </div>

            {view.isSavedRecipe && <MoreOptionsSection view={view} />}

            {view.showUnknownCost && <StartJobUnknownCost view={view} />}

            {view.isSavedRecipe && <StartJobInputs view={view} />}

            <Checklist view={view}>
              <ChecklistContent view={view} />
            </Checklist>

            <StartJobScheduled view={view} />

            {view.error && (
              <p className="start-error" role="alert">
                {view.error}
              </p>
            )}

            {view.authNeeded && <AuthSection view={view} inputRef={authInputRef} />}

            <StartJobActions view={view} />
          </>
        )}
      </div>
    </div>
  )
}

function AskSection({ view }: { view: StartJobView }) {
  return (
    <fieldset className="inner start-ask" data-protected="block" style={{ border: 0, margin: 0 }}>
      <legend className="lab start-legend">Ask me before</legend>
      <AskChoices view={view} />
    </fieldset>
  )
}

function HelpersSection({ view }: { view: StartJobView }) {
  return (
    <details
      className="inner start-helpers"
      data-protected="block"
      open={view.helperProblem ? true : undefined}
    >
      <summary>
        Helpers
        {view.helpersOn && (
          <span className="small muted">
            {' '}
            · {view.helperIds.length} {view.helperIds.length === 1 ? 'helper' : 'helpers'}
            {view.helperScan && <> · scans {view.helperFolderNow.trim() || 'no folder yet'}</>}
          </span>
        )}
      </summary>
      <HelperFields view={view} />
    </details>
  )
}

function CheckSection({ view }: { view: StartJobView }) {
  return (
    <details
      className="inner start-check"
      data-protected="block"
      open={view.checkProblem ? true : undefined}
    >
      <summary>
        Check before it finishes
        {/* The folder stays in sight when the section is folded: the command runs there as you. */}
        {view.checkCommand.trim() !== '' && (
          <span className="small muted start-check-where">
            {' '}
            · runs in {view.checkFolderNow.trim() || 'no folder yet'}
          </span>
        )}
      </summary>
      <CheckFields view={view} />
    </details>
  )
}

function LimitsSection({ view }: { view: StartJobView }) {
  return (
    <div className="inner start-limits" data-protected="block">
      <LimitsFields view={view} />
    </div>
  )
}

function MoreOptionsSection({ view }: { view: StartJobView }) {
  return (
    <details className="inner start-more" data-protected="block">
      <summary>More options</summary>
      <MoreOptionsFields view={view} />
    </details>
  )
}

function AuthSection({
  view,
  inputRef,
}: {
  view: StartJobView
  inputRef: RefObject<HTMLInputElement | null>
}) {
  return (
    <form
      className="inner start-check start-check-auth"
      data-protected="block"
      aria-label="Confirm it’s you"
      onSubmit={view.submitAuth}
    >
      <AuthFields view={view} inputRef={inputRef} />
    </form>
  )
}

function Checklist({ view, children }: { view: StartJobView; children: ReactNode }) {
  return (
    <section className="inner start-checks" aria-label="Before it starts" data-protected="block">
      <span className="lab">Before it starts</span>
      <ChecklistRows
        checks={view.checks}
        reload={
          view.leadId ? (
            <ReloadMcp
              agentId={view.leadId}
              agentName={view.leadAgent?.name ?? view.leadId}
              onReloaded={() => void view.orchestrationPreflight.refetch()}
            />
          ) : undefined
        }
      />
      {children}
    </section>
  )
}

function TriggerResult({
  result,
  onClose,
}: {
  result: Extract<Result, { kind: 'trigger' }>
  onClose: () => void
}) {
  return (
    <div className="start-result">
      <h3>Trigger created</h3>
      <p className="muted">
        Send the app’s calls to this address. The secret is shown once; copy it now.
      </p>
      <div className="inner start-secret" data-protected="block">
        <span className="lab">Address</span>
        <div className="row wrap">
          <code className="grow">{result.url ?? 'Score is reachable only on this machine'}</code>
          {result.url && <CopyButton text={result.url} label="Copy address" />}
        </div>
        <span className="lab">Signing secret</span>
        <div className="row wrap">
          <code className="grow">{result.secret}</code>
          <CopyButton text={result.secret} label="Copy secret" />
        </div>
        <span className="small muted">
          Calls must be signed with the secret and arrive within five minutes. You can show the
          secret again from Settings › Tools and triggers.
        </span>
      </div>
      <div className="row wrap start-actions">
        <button type="button" className="btn primary start-cancel" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
