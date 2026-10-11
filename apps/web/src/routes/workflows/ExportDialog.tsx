import { useEffect, useRef, useState } from 'react'
import { describeOrchError } from '../orchestrations/orchestration-queries.ts'
import { useExportWorkflow } from './workflow-queries.ts'
import '../orchestrations/orchestrations.css'
import './workflows.css'

/**
 * Export one version as JSON. The export is scrubbed (secrets-looking text is redacted) but not guaranteed secret-free,
 * so the person sees every change the scrubber made and can remove any field before downloading.
 */
export function ExportDialog({
  workflowId,
  version,
  name,
  close,
}: {
  workflowId: string
  version: number
  name: string
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const exported = useExportWorkflow()
  const [removed, setRemoved] = useState<string[]>([])
  const { mutate } = exported
  // The fields that can be left out are read from the first, complete export: once one is removed it is gone from later ones.
  const [fields, setFields] = useState<{ path: string; label: string }[]>([])
  const first = useRef(true)
  useEffect(() => {
    dialog.current?.showModal?.()
    mutate({ id: workflowId, version, removePaths: [] })
  }, [mutate, workflowId, version])

  const data = exported.data
  useEffect(() => {
    if (!data || !first.current) return
    first.current = false
    setFields(
      data.portable.nodes.flatMap((node, index) =>
        node.kind === 'agent'
          ? [{ path: `nodes[${index}].instruction`, label: `${node.label}: instruction` }]
          : node.kind === 'gate'
            ? [{ path: `nodes[${index}].question`, label: `${node.label}: question` }]
            : [],
      ),
    )
  }, [data])
  const json = data ? JSON.stringify({ format: data.format, ...data.portable }, null, 2) : ''

  function download() {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'workflow'
    }-v${version}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="orch-dialog"
      aria-labelledby="wf-export-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="orch-dialog-head">
        <h2 id="wf-export-title">Export {name}</h2>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      <p className="orch-muted">
        Version {version} as JSON, without any run data. Agents are described by name and role, not
        by id. Score removes anything that looks like a secret but can’t promise the file holds
        none, so read it before you share it.
      </p>
      {exported.isPending && <p role="status">Preparing the export…</p>}
      {exported.isError && (
        <p role="alert" className="orch-error">
          {describeOrchError(exported.error)}
        </p>
      )}
      {data && (
        <>
          <section aria-label="What Score changed">
            <h3>What Score changed</h3>
            {data.changes.length === 0 ? (
              <p className="orch-muted">Nothing looked like a secret, so nothing was changed.</p>
            ) : (
              <ul className="wf-changes">
                {data.changes.map((change) => (
                  <li key={change.path}>
                    <code>{change.path}</code>
                    <div className="wf-diff">
                      <div>
                        <small className="orch-muted">Before</small>
                        <pre className="orch-pre">{change.before}</pre>
                      </div>
                      <div>
                        <small className="orch-muted">In the export</small>
                        <pre className="orch-pre">{change.after}</pre>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Leave fields out">
            <h3>Leave fields out</h3>
            <p className="orch-muted">
              Tick anything you don’t want in the file, then update the preview. Score checks the
              result again.
            </p>
            <ul className="wf-leave" aria-label="Fields">
              {fields.map((field) => (
                <li key={field.path}>
                  <label className="orch-check">
                    <input
                      type="checkbox"
                      checked={removed.includes(field.path)}
                      onChange={(event) =>
                        setRemoved((current) =>
                          event.target.checked
                            ? [...current, field.path]
                            : current.filter((path) => path !== field.path),
                        )
                      }
                    />
                    Leave out {field.label}
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={exported.isPending}
              onClick={() => mutate({ id: workflowId, version, removePaths: removed })}
            >
              Update the preview
            </button>
          </section>
          {!data.validation.ok && (
            <p role="alert" className="orch-error">
              Without those fields the workflow is no longer complete:{' '}
              {data.validation.issues
                .filter((i) => i.severity === 'error')
                .map((i) => i.message)
                .join(' ')}
            </p>
          )}
          <details>
            <summary>The file</summary>
            <pre className="orch-pre">{json}</pre>
          </details>
          <div className="orch-actions">
            <button type="button" className="orch-primary" onClick={download}>
              Download JSON
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}
