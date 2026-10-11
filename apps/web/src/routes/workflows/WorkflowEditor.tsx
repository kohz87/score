import type { WorkflowDetail, WorkflowNodeKind } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router'
import { ResponsiveDrawer } from '../../components/ResponsiveDrawer.tsx'
import { ApiError } from '../../data/api.ts'
import { NARROW_QUERY, useMediaQuery } from '../../data/use-media.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { taskAgentsQuery } from '../tasks/task-queries.ts'
import { EditorCanvas, type Selection } from './EditorCanvas.tsx'
import { ExportDialog } from './ExportDialog.tsx'
import { IssueList, InputsEditor, Outline, Palette } from './EditorParts.tsx'
import { NodeInspector } from './NodeInspector.tsx'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'
import { useDraftHistory } from './use-draft-history.ts'
import { placeNewNode } from './workflow-layout.ts'
import {
  addNode,
  connect,
  disconnect,
  portsOf,
  removeNode,
  sameDraft,
  starterDraft,
  updateNode,
  type Draft,
} from './workflow-model.ts'
import {
  latestVersionOf,
  useSaveWorkflow,
  useValidation,
  useWorkflow,
  fetchWorkflowVersion,
} from './workflow-queries.ts'
import {
  combine,
  indexIssues,
  issuesForNode,
  shapeIssues,
  summaryLine,
} from './workflow-validation.ts'
import '../orchestrations/orchestrations.css'
import './workflows.css'

/** The route: `/now/flow/workflows/new` or `/now/flow/workflows/:workflowId`. */
export function WorkflowEditorRoute() {
  const { workflowId: param } = useParams()
  const workflowId = param === 'new' ? undefined : param
  const detail = useWorkflow(workflowId)
  if (workflowId === undefined) return <WorkflowEditor key="new" detail={null} />
  if (detail.isError)
    return (
      <p role="alert" className="orch-error">
        This workflow could not load. <Link to="/now/flow/workflows">Back to the workflows</Link>
      </p>
    )
  if (!detail.data) return <p role="status">Loading the workflow…</p>
  return <WorkflowEditor key={workflowId} detail={detail.data} />
}

function WorkflowEditor({ detail }: { detail: WorkflowDetail | null }) {
  const navigate = useNavigate()
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const firstAgent = agents.find((agent) => !agent.runtime || agent.runtime === 'hermes')?.id ?? ''
  const narrow = useMediaQuery(NARROW_QUERY)
  const history = useDraftHistory<Draft>(detail?.latest.definition ?? starterDraft(''))
  const { draft, commit } = history
  // The starter draft needs an agent to start with; fill it in once the team has loaded.
  const seeded = useRef(detail !== null)
  const { reset } = history
  const [saved, setSaved] = useState<{
    workflowId: string | null
    version: number
    definition: Draft
  }>(() => ({
    workflowId: detail?.id ?? null,
    version: detail?.latestVersion ?? 0,
    definition: detail?.latest.definition ?? starterDraft(''),
  }))
  useEffect(() => {
    if (!seeded.current && firstAgent) {
      seeded.current = true
      const starter = starterDraft(firstAgent)
      reset(starter)
      // A brand new workflow counts as unchanged until the starter draft is edited.
      setSaved((current) => ({ ...current, definition: starter }))
    }
  }, [firstAgent, reset])
  const location = useLocation()
  const allowLeave = useRef(false)
  const [selected, setSelected] = useState<Selection>(null)
  const [message, setMessage] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [conflict, setConflict] = useState<number | null>(null)
  const [justSaved, setJustSaved] = useState<number | null>(
    () => (location.state as { savedVersion?: number } | null)?.savedVersion ?? null,
  )
  const save = useSaveWorkflow()
  const announce = useCallback((text: string) => setMessage(text), [])

  const shape = useMemo(() => shapeIssues(draft), [draft])
  const validation = useValidation(shape.length === 0 ? draft : null)
  const issues = useMemo(
    () => combine(shape, shape.length === 0 ? validation.data : undefined),
    [shape, validation.data],
  )
  const index = useMemo(() => indexIssues(issues), [issues])
  const checking = shape.length === 0 && (validation.pending || validation.isPending)
  const dirty = !sameDraft(draft, saved.definition)
  const canSave =
    shape.length === 0 &&
    !checking &&
    index.errors === 0 &&
    !save.isPending &&
    (dirty || saved.workflowId === null)

  // Leaving with unsaved work asks first.
  const blocker = useBlocker(() => dirty && !allowLeave.current)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm('You have unsaved changes. Leave without saving?')) blocker.proceed()
    else blocker.reset()
  }, [blocker])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const selectedNode =
    selected?.kind === 'node' ? draft.nodes.find((node) => node.id === selected.id) : undefined

  function addAfter(
    kind: WorkflowNodeKind,
    agentId = '',
    after: string | null = selectedNode?.id ?? null,
  ) {
    const result = addNode(draft, kind, agentId)
    if ('error' in result) return announce(result.error)
    let next = result.draft
    const source = after ? next.nodes.find((node) => node.id === after) : undefined
    const agent = agents.find((item) => item.id === agentId)
    if (kind === 'agent' && agent)
      next = updateNode(next, result.id, { label: `${agent.name} step` })
    let note = `Added ${kind === 'agent' && agent ? `${agent.name} step` : kind}.`
    if (source && source.kind !== 'end') {
      // The first way out of the selected node that leads nowhere yet (never a failure or rejection route).
      const free = portsOf(source).find(
        (port) =>
          port.id !== 'failed' &&
          port.id !== 'rejected' &&
          !next.edges.some((edge) => edge.from === source.id && edge.port === port.id),
      )
      if (free) {
        const joined = connect(next, source.id, free.id, result.id)
        if ('draft' in joined) {
          next = joined.draft
          note = `${note} Connected after ${source.label}.`
        }
      }
      if (kind === 'branch' && source.kind === 'agent')
        next = updateNode(next, result.id, { subject: source.id })
    }
    next = placeNewNode(next, result.id, new Map(), after)
    commit(next)
    setSelected({ kind: 'node', id: result.id })
    announce(note)
  }

  function deleteNode(id: string) {
    commit(removeNode(draft, id))
    setSelected(null)
  }
  function deleteEdge(id: string) {
    commit(disconnect(draft, id))
    setSelected(null)
    announce('Removed the connection.')
  }

  function onSave() {
    save.mutate(
      { workflowId: saved.workflowId, baseVersion: saved.version, definition: draft },
      {
        onSuccess: (version) => {
          setConflict(null)
          setSaved({ workflowId: version.workflowId, version: version.version, definition: draft })
          setJustSaved(version.version)
          announce(`Saved as version ${version.version}.`)
          if (saved.workflowId === null) {
            allowLeave.current = true
            void navigate(`/now/flow/workflows/${encodeURIComponent(version.workflowId)}`, {
              replace: true,
              state: { savedVersion: version.version },
            })
          }
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'conflict')
            setConflict(latestVersionOf(error.details) ?? saved.version + 1)
        },
      },
    )
  }

  const latest = useWorkflow(saved.workflowId ?? undefined)
  const queryClient = useQueryClient()
  async function loadVersion(version: number) {
    if (saved.workflowId === null) return
    try {
      const loaded = await fetchWorkflowVersion(queryClient, saved.workflowId, version)
      commit(loaded.definition)
      announce(`Loaded version ${version} into the draft. Saving makes it a new version.`)
    } catch {
      announce(`Could not load version ${version}.`)
    }
  }

  const headline = summaryLine(index, checking)
  const versions = latest.data?.versions ?? detail?.versions ?? []
  const inspector = selectedNode ? (
    <NodeInspector
      draft={draft}
      node={selectedNode}
      agents={agents}
      issues={issuesForNode(index, draft, selectedNode.id)}
      commit={commit}
      onDelete={() => deleteNode(selectedNode.id)}
      announce={announce}
    />
  ) : (
    <div className="wf-inspector wf-inspector--empty">
      <h3>Nothing selected</h3>
      <p className="orch-muted">
        Select a node on the canvas, in the outline or in the list of problems to edit it here.
      </p>
    </div>
  )

  return (
    <div className="wf-editor">
      <header className="wf-editor__head">
        <div className="wf-editor__title">
          <Link to="/now/flow/workflows" className="wf-back">
            All workflows
          </Link>
          <label className="wf-name">
            <span className="wf-visually-hidden">Workflow name</span>
            <input
              value={draft.name}
              maxLength={120}
              aria-invalid={draft.name.trim() === '' || undefined}
              onChange={(event) => commit({ ...draft, name: event.target.value }, 'name')}
            />
          </label>
          <p className="orch-muted">
            {saved.workflowId === null
              ? 'Not saved yet'
              : `Version ${saved.version}${versions.find((v) => v.version === saved.version)?.used ? ', used by runs' : ''}`}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        </div>
        <div className="wf-editor__actions">
          <button type="button" disabled={!history.canUndo} onClick={history.undo}>
            Undo
          </button>
          <button type="button" disabled={!history.canRedo} onClick={history.redo}>
            Redo
          </button>
          <button
            type="button"
            className="orch-primary"
            disabled={!canSave}
            title={index.errors > 0 ? 'Fix the problems first' : undefined}
            onClick={onSave}
          >
            {save.isPending ? 'Saving…' : 'Save as new version'}
          </button>
          {saved.workflowId !== null && (
            <>
              <button
                type="button"
                disabled={dirty || checking}
                title={dirty ? 'Save first: a run uses a saved version' : undefined}
                onClick={() => setStarting(true)}
              >
                Run…
              </button>
              <button type="button" disabled={dirty} onClick={() => setExporting(true)}>
                Export
              </button>
            </>
          )}
        </div>
      </header>

      <p role="status" className="wf-visually-hidden" aria-live="polite">
        {message}
      </p>
      {justSaved !== null && !dirty && (
        <p role="status" className="wf-saved">
          Saved as version {justSaved}.
        </p>
      )}
      {conflict !== null && (
        <section
          role="alert"
          className="orch-decision wf-conflict"
          aria-label="Someone saved first"
        >
          <h3>A newer version exists</h3>
          <p>
            Version {conflict} was saved while you were editing version {saved.version}, from
            another tab or window. Your changes are still here and nothing was overwritten.
          </p>
          <div className="orch-actions">
            <button
              type="button"
              className="orch-primary"
              onClick={() => {
                void latest.refetch().then((result) => {
                  if (result.data) {
                    reset(result.data.latest.definition)
                    setSaved({
                      workflowId: result.data.id,
                      version: result.data.latestVersion,
                      definition: result.data.latest.definition,
                    })
                    setSelected(null)
                    setConflict(null)
                    announce(
                      `Reloaded version ${result.data.latestVersion}. Your edits were discarded.`,
                    )
                  }
                })
              }}
            >
              Reload version {conflict} (discard my edits)
            </button>
            <button
              type="button"
              onClick={() => {
                setSaved((current) => ({ ...current, version: conflict }))
                setConflict(null)
                announce(
                  `Your draft now builds on version ${conflict}. Save to add it as the next version.`,
                )
              }}
            >
              Keep my draft and build on version {conflict}
            </button>
          </div>
        </section>
      )}
      {save.isError && !(save.error instanceof ApiError && save.error.code === 'conflict') && (
        <p role="alert" className="orch-error">
          {save.error instanceof ApiError && save.error.code === 'quota_exhausted'
            ? 'This workflow already has as many saved versions as Score keeps (or there are too many workflows). Delete one you do not use.'
            : save.error instanceof ApiError && save.error.code === 'invalid_definition'
              ? 'The server found a problem with this workflow. The list of problems shows what.'
              : 'That did not save. Please try again.'}
        </p>
      )}

      <div className="wf-editor__body">
        <aside className="wf-side wf-side--left" aria-label="Tools">
          <Palette
            agents={agents}
            onAdd={(kind, agentId) => addAfter(kind, agentId)}
            disabled={false}
          />
          <InputsEditor draft={draft} commit={commit} issues={index.general} />
          <section aria-label="Workflow details" className="wf-details">
            <h3>About this workflow</h3>
            <label className="orch-field">
              <span>Description (optional)</span>
              <textarea
                rows={2}
                maxLength={500}
                value={draft.description ?? ''}
                onChange={(event) => {
                  const next = { ...draft }
                  if (event.target.value === '') delete next.description
                  else next.description = event.target.value
                  commit(next, 'description')
                }}
              />
            </label>
            {versions.length > 1 && (
              <label className="orch-field">
                <span>Start from an older version</span>
                <select
                  value=""
                  onChange={(event) => {
                    const version = Number(event.target.value)
                    if (version) void loadVersion(version)
                  }}
                >
                  <option value="">Choose a version…</option>
                  {[...versions].reverse().map((v) => (
                    <option key={v.version} value={v.version}>
                      Version {v.version}
                      {v.used ? ' (used by runs)' : ''}, {v.nodes} nodes
                    </option>
                  ))}
                </select>
                <small className="orch-muted">
                  Copies it into the draft. Saving adds it as a new version; old versions never
                  change.
                </small>
              </label>
            )}
          </section>
        </aside>

        <main className="wf-main">
          <div className="wf-main__bar">
            <span
              className={`wf-summary wf-summary--${index.errors > 0 ? 'error' : checking ? 'checking' : 'ok'}`}
              role="status"
            >
              {headline}
            </span>
            {narrow && (
              <button type="button" disabled={!selectedNode} onClick={() => setInspectorOpen(true)}>
                {selectedNode ? `Edit ${selectedNode.label}` : 'Select a node to edit it'}
              </button>
            )}
          </div>
          <EditorCanvas
            draft={draft}
            agents={agents}
            issues={index}
            selected={selected}
            onSelect={(next) => {
              setSelected(next)
              if (next?.kind === 'node' && narrow) setInspectorOpen(false)
            }}
            onConnect={(from, port, to) => {
              const result = connect(draft, from, port, to)
              if ('error' in result) return result.error
              commit(result.draft)
              const names = (id: string) => draft.nodes.find((node) => node.id === id)?.label ?? id
              announce(`Connected ${names(from)} to ${names(to)}.`)
              return null
            }}
            onDropKind={(payload, onto) => addAfter(payload.kind, payload.agentId, onto)}
            onDeleteNode={deleteNode}
            onDeleteEdge={deleteEdge}
            onLayout={(next, key) => commit(next, key)}
            announce={announce}
          />
          <IssueList
            issues={issues}
            draft={draft}
            onSelect={setSelected}
            checking={checking}
            headline={headline}
          />
          <Outline draft={draft} issues={index} selected={selected} onSelect={setSelected} />
        </main>

        <ResponsiveDrawer
          label="Node settings"
          className="wf-side wf-side--right"
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
        >
          {narrow && (
            <button
              type="button"
              className="wf-drawer-close"
              onClick={() => setInspectorOpen(false)}
            >
              Close
            </button>
          )}
          {inspector}
        </ResponsiveDrawer>
      </div>

      {starting && saved.workflowId && (
        <StartWorkflowDialog
          workflowId={saved.workflowId}
          version={saved.version}
          agents={agents}
          close={() => setStarting(false)}
          created={(run) => {
            setStarting(false)
            void navigate(`/now/flow/${encodeURIComponent(run.briefId)}`)
          }}
        />
      )}
      {exporting && saved.workflowId && (
        <ExportDialog
          workflowId={saved.workflowId}
          version={saved.version}
          name={draft.name}
          close={() => setExporting(false)}
        />
      )}
    </div>
  )
}
