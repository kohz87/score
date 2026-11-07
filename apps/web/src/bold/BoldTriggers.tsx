import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Trigger } from '@score/contract'
import { useTeamChoice } from './room/team-choice.tsx'
import { cleanMapping } from './trigger-model.ts'
import {
  createTrigger,
  deleteTrigger,
  rotateTrigger,
  showTriggerSecret,
  triggersKey,
  updateTrigger,
  useTriggers,
  type TriggerCreateRequest,
} from './trigger-queries.ts'
import {
  CONFIRM_TITLE,
  blankWizard,
  editWizard,
  plainProblem,
  reportBackOf,
  teamNameOf,
  type Confirmation,
  type Secret,
  type Wizard,
} from './triggers/wizard-model.ts'
import { SecretCard } from './triggers/SecretCard.tsx'
import { TriggerCard } from './triggers/TriggerCard.tsx'
import { WizardBody } from './triggers/WizardBody.tsx'

/** PLAN 11.9a: the prototype's vTriggerWizard and sTools triggers, backed by contract §17. */
export function BoldTriggers({ appSuggestions = [] }: { appSuggestions?: string[] }) {
  const queryClient = useQueryClient()
  const [wizard, setWizard] = useState<Wizard | null>(null)
  const [secret, setSecret] = useState<Secret | null>(null)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const teams = useTeamChoice()
  const triggers = useTriggers(wizard?.step === 2)
  const live = wizard?.triggerId
    ? triggers.data?.find((trigger) => trigger.id === wizard.triggerId)
    : undefined
  const sample = live?.sample ?? wizard?.sample ?? null
  const url = live?.url ?? wizard?.url ?? null

  // The contract has no draft trigger: once step 1 made the address it is live, and every call starts a job with the
  // placeholder wording. Closing before the mapping is saved asks whether to keep it.
  const closeWizard = useCallback(
    ({ saved = false }: { saved?: boolean } = {}) => {
      if (!saved && wizard?.mode === 'create' && wizard.triggerId)
        setConfirm({
          kind: 'unfinished',
          trigger: { id: wizard.triggerId, name: wizard.name.trim() },
        })
      setWizard(null)
      setSecret(null)
    },
    [wizard],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (secret) setSecret(null)
      else if (confirm) setConfirm(null)
      else if (wizard) closeWizard()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [closeWizard, confirm, secret, wizard])

  const update = (change: Partial<Wizard>) =>
    setWizard((current) => (current ? { ...current, ...change } : current))
  const invalidate = () => queryClient.invalidateQueries({ queryKey: triggersKey })

  async function createAddress() {
    if (!wizard) return
    const request: TriggerCreateRequest = {
      name: wizard.name.trim(),
      app: wizard.app.trim(),
      // The contract has no draft trigger or test-call endpoint. This safe starting map lets the app make its one
      // signed test call; the mapping is replaced on the last step before the person shares the address.
      mapping: { ref: 'id' },
      template: 'A call from the app started a job.',
      reportBack: { mode: 'off' },
      ...(teams.several ? { teamRoomId: wizard.teamRoomId } : {}),
    }
    update({ busy: true, problem: '' })
    try {
      const made = await createTrigger(request)
      setWizard((current) =>
        current
          ? {
              ...current,
              triggerId: made.trigger.id,
              url: made.trigger.url,
              // The create request carries a safe starting map and template only because the contract has no draft
              // state; the person maps the real call and writes the job's wording from step 3.
              mapping: { ref: '', title: '', link: '', details: '' },
              template: '',
              sample: made.trigger.sample,
              step: 2,
              busy: false,
            }
          : current,
      )
      setSecret({ triggerId: made.trigger.id, name: made.trigger.name, value: made.secret })
      void invalidate()
    } catch (error) {
      update({ busy: false, problem: plainProblem(error, 'create this trigger') })
    }
  }

  async function saveTrigger() {
    if (!wizard?.triggerId) return
    update({ busy: true, problem: '' })
    try {
      await updateTrigger(wizard.triggerId, {
        name: wizard.name.trim(),
        app: wizard.app.trim(),
        mapping: cleanMapping(wizard.mapping),
        template: wizard.template.trim(),
        reportBack: reportBackOf(wizard),
        ...(teams.several ? { teamRoomId: wizard.teamRoomId } : {}),
      })
      setNotice(
        wizard.mode === 'edit'
          ? 'Trigger saved.'
          : `Trigger saved. The next call from ${wizard.app} starts a job in ${
              teams.several
                ? (teams.teams.find((team) => team.id === wizard.teamRoomId)?.name ??
                  teams.teams[0]!.name)
                : 'the team room'
            }.`,
      )
      closeWizard({ saved: true })
      void invalidate()
    } catch (error) {
      update({ busy: false, problem: plainProblem(error, 'save this trigger') })
    }
  }

  async function reveal(trigger: Trigger) {
    setPending(`secret:${trigger.id}`)
    setNotice('')
    try {
      const value = await showTriggerSecret(trigger.id)
      setSecret({ triggerId: trigger.id, name: trigger.name, value })
    } catch (error) {
      setNotice(plainProblem(error, 'show this secret'))
    } finally {
      setPending(null)
    }
  }

  async function showWizardSecret() {
    if (!wizard?.triggerId) return
    setPending('wizard-secret')
    try {
      const value = await showTriggerSecret(wizard.triggerId)
      setSecret({ triggerId: wizard.triggerId, name: wizard.name, value })
    } catch (error) {
      update({ problem: plainProblem(error, 'show this secret') })
    } finally {
      setPending(null)
    }
  }

  async function confirmAction() {
    if (!confirm) return
    const { kind, trigger } = confirm
    setPending(kind)
    setNotice('')
    try {
      if (kind === 'rotate') {
        const value = await rotateTrigger(trigger.id)
        setSecret({ triggerId: trigger.id, name: trigger.name, value })
        setNotice('Secret rotated. The old secret stops working now.')
      } else {
        await deleteTrigger(trigger.id)
        setNotice(`Deleted ${trigger.name}. Its address stops working.`)
      }
      setConfirm(null)
      void invalidate()
    } catch (error) {
      setNotice(
        plainProblem(error, kind === 'rotate' ? 'rotate this secret' : 'delete this trigger'),
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="card bold-triggers" aria-labelledby="bold-triggers-title">
      <div className="row wrap">
        <h3 id="bold-triggers-title">Triggers</h3>
        <span className="small muted">Let another app start a job by calling an address</span>
        <button
          type="button"
          className="btn sm primary bold-trigger-push"
          onClick={() => {
            setNotice('')
            setSecret(null)
            setWizard(blankWizard())
          }}
        >
          New trigger
        </button>
      </div>
      {triggers.isPending && <p role="status">Loading triggers…</p>}
      {triggers.isError && <p role="alert">Couldn’t load triggers. Try again later.</p>}
      {triggers.data?.length === 0 && (
        <span className="small muted">No triggers yet. Make one to let an app start a job.</span>
      )}
      <div className="bold-trigger-list">
        {triggers.data?.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            busy={pending !== null}
            teamName={teamNameOf(trigger, teams)}
            onEdit={() => {
              setNotice('')
              setSecret(null)
              setWizard(editWizard(trigger))
            }}
            onReveal={() => void reveal(trigger)}
            onRotate={() => setConfirm({ kind: 'rotate', trigger })}
            onDelete={() => setConfirm({ kind: 'delete', trigger })}
          />
        ))}
      </div>
      {notice && <p role="status">{notice}</p>}

      {wizard && (
        <div className="bold-trigger-scrim">
          <div
            className={`bold-trigger-dialog${wizard.step === 3 ? ' wide' : ''}`}
            data-trigger-step={wizard.step}
            role="dialog"
            aria-modal="true"
            aria-label={wizard.mode === 'edit' ? 'Edit trigger' : 'New trigger'}
          >
            <WizardBody
              wizard={wizard}
              sample={sample}
              url={url}
              secret={secret?.triggerId === wizard.triggerId ? secret : null}
              appSuggestions={appSuggestions}
              teams={teams}
              onChange={update}
              onClose={closeWizard}
              onCreate={() => void createAddress()}
              onShowSecret={() => void showWizardSecret()}
              onSecretClose={() => setSecret(null)}
              onSave={() => void saveTrigger()}
              onRefresh={() => void triggers.refetch()}
            />
          </div>
        </div>
      )}

      {!wizard && secret && (
        <div className="bold-trigger-scrim">
          <div
            className="bold-trigger-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Trigger secret"
          >
            <SecretCard secret={secret} onClose={() => setSecret(null)} />
          </div>
        </div>
      )}

      {confirm && (
        <div className="bold-trigger-scrim">
          <section
            className="card bold-trigger-confirm"
            data-protected="flex"
            role="alertdialog"
            aria-modal="true"
            aria-label={CONFIRM_TITLE[confirm.kind]}
          >
            <h3>{CONFIRM_TITLE[confirm.kind]}</h3>
            <p>
              {confirm.kind === 'rotate'
                ? 'The old secret stops working immediately. Every app sending this trigger must be updated with the new one.'
                : confirm.kind === 'unfinished'
                  ? `${confirm.trigger.name} is already live: until you finish it, every call to its address starts a job with placeholder wording. Delete it, or keep it and finish it later from its Edit button.`
                  : `Calls to ${confirm.trigger.name} will stop working. Past jobs stay in the team room.`}
            </p>
            {pending === confirm.kind && <p role="status">Working…</p>}
            <div className="row wrap bold-trigger-actions">
              <button
                type="button"
                className="link"
                onClick={() => setConfirm(null)}
                disabled={pending !== null}
              >
                {confirm.kind === 'unfinished' ? 'Keep it for now' : 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn primary bold-trigger-push${confirm.kind === 'rotate' ? '' : ' bold-trigger-danger'}`}
                disabled={pending !== null}
                onClick={() => void confirmAction()}
              >
                {confirm.kind === 'rotate' ? 'Rotate secret' : 'Delete trigger'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
