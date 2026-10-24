import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AboutSchema, UpdateCheckSchema, type About, type UpdateCheck } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { copyText, selectText } from '../../data/clipboard.ts'
import { failure } from './TerminalCommand.tsx'

/** A folder name safe to paste after `cd`: plain paths stay as they are, anything else is single-quoted. */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

export function updateSteps(checkout: string): string[] {
  return [
    `cd ${shellPath(checkout)}`,
    'git pull --ff-only',
    'pnpm install --frozen-lockfile',
    'pnpm build',
    'scripts/score stop',
  ]
}

function UpdateSteps({ checkout }: { checkout: string }) {
  const steps = updateSteps(checkout)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const block = useRef<HTMLElement>(null)
  async function copy() {
    if (await copyText(steps.join('\n'))) setCopied('copied')
    else {
      selectText(block.current)
      setCopied('manual')
    }
  }
  return (
    <div className="settings-command" role="group" aria-label="Steps to update">
      <p>
        Score doesn’t update itself. <a href="#backup">Back up first</a>, then run these in a
        terminal on this machine:
      </p>
      <code ref={block} className="settings-command-text about-steps">
        {steps.join('\n')}
      </code>
      <p>Then start Score again the way you usually do.</p>
      <div className="settings-command-actions">
        <button type="button" className="settings-pill" onClick={() => void copy()}>
          {copied === 'copied' ? 'Copied' : 'Copy commands'}
        </button>
      </div>
      {copied === 'manual' && (
        <p role="status">The commands are selected: press Ctrl+C (or ⌘C) to copy them.</p>
      )}
    </div>
  )
}

function Result({ result, checkout }: { result: UpdateCheck; checkout: string }) {
  return (
    <div className="about-result" role="status">
      <p>{result.message}</p>
      {result.status === 'update_available' && result.latest && (
        <>
          <p className="about-links">
            <a href={result.latest.changelogUrl} target="_blank" rel="noreferrer">
              What’s new
            </a>
            <a href={result.latest.url} target="_blank" rel="noreferrer">
              Release page
            </a>
          </p>
          <UpdateSteps checkout={checkout} />
        </>
      )}
    </div>
  )
}

const SERVICE_COMMAND = 'scripts/score service install'

function ServiceFact({ service }: { service: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const code = useRef<HTMLElement>(null)
  async function copy() {
    if (await copyText(SERVICE_COMMAND)) setCopied('copied')
    else {
      selectText(code.current)
      setCopied('manual')
    }
  }
  return (
    <div>
      <dt>Runs as a service</dt>
      {service ? (
        <dd>Yes — starts at boot and restarts after a crash</dd>
      ) : (
        <dd>
          No — <code ref={code}>{SERVICE_COMMAND}</code> turns it on{' '}
          <button type="button" className="settings-pill" onClick={() => void copy()}>
            {copied === 'copied' ? 'Copied' : 'Copy command'}
          </button>
          {copied === 'manual' && (
            <span role="status"> The command is selected: press Ctrl+C (or ⌘C) to copy it.</span>
          )}
        </dd>
      )}
    </div>
  )
}

const rows = (about: About): [string, string][] => [
  ['Build', about.commit ?? 'Not a git checkout'],
  ['Database schema', String(about.schema)],
  ['Contract', String(about.contract)],
  ['Hermes', about.hermes?.version ?? 'Not connected'],
  ['Node', about.node],
  ['Mode', about.mode === 'fake' ? 'Demo (fake data)' : 'Live'],
]

/** Settings › About: what is running, and an update check that only happens when you press the button. */
export function AboutSection({ heading = 'About Score' }: { heading?: string } = {}) {
  const about = useQuery({
    queryKey: ['about'],
    queryFn: async ({ signal }) => AboutSchema.parse(await apiFetch('about', { signal })),
    retry: false,
    staleTime: Infinity,
  })
  const check = useMutation({
    mutationFn: async () =>
      UpdateCheckSchema.parse(await apiFetch('about/update-check', { method: 'POST' })),
  })
  const data = about.data
  return (
    <section id="about" className="settings-card" aria-labelledby="settings-about">
      <h2 id="settings-about">{heading}</h2>
      {data ? (
        <>
          <p className="about-version">Score v{data.version}</p>
          <dl className="about-facts">
            {rows(data).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <ServiceFact service={data.service} />
          </dl>
          <p>
            <a href={data.repository} target="_blank" rel="noreferrer">
              Score on GitHub
            </a>
          </p>
          <div className="about-check">
            <button
              type="button"
              className="settings-pill settings-start"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check for updates'}
            </button>
            <p className="settings-muted">
              Only when you press this, Score asks GitHub for the list of released versions. It
              sends nothing about you.
            </p>
          </div>
          {check.data && <Result result={check.data} checkout={data.checkout} />}
          {check.isError && <p role="alert">{failure(check.error, 'check for updates')}</p>}
        </>
      ) : about.isError ? (
        <p role="alert">Couldn’t load the version details. Reload the page to try again.</p>
      ) : (
        <p className="settings-muted">Loading…</p>
      )}
    </section>
  )
}
