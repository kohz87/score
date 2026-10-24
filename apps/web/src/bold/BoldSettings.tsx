import { Navigate, useNavigate, useParams } from 'react-router'
import { BoldUsage } from './BoldUsage.tsx'
import { saveUi } from './bold-ui.ts'
import './bold-settings.css'

type SettingsSection =
  | 'connections'
  | 'tools'
  | 'rules'
  | 'notifications'
  | 'look'
  | 'usage'
  | 'security'
  | 'advanced'
  | 'system'

type SettingsItem = {
  id: SettingsSection
  title: string
  description: string
  phase?: '11.9a' | '11.9b'
}

// Prototype SECS (docs/design/bold/prototype.html), which supersedes board 05's four groups.
export const SETTINGS_SECTIONS: readonly SettingsItem[] = [
  {
    id: 'connections',
    title: 'Connections',
    description: 'Hermes, models, channels',
    phase: '11.9a',
  },
  {
    id: 'tools',
    title: 'Tools and triggers',
    description: 'Apps agents use; webhooks that start jobs',
    phase: '11.9a',
  },
  { id: 'rules', title: 'Rules', description: 'What agents may do alone', phase: '11.9b' },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'What reaches you, where',
    phase: '11.9b',
  },
  { id: 'look', title: 'Look', description: 'Dark or light, motion, text', phase: '11.9a' },
  { id: 'usage', title: 'Usage', description: 'What got done, what it cost' },
  {
    id: 'security',
    title: 'Remote access and security',
    description: 'Paired devices, password, terminal',
    phase: '11.9b',
  },
  { id: 'advanced', title: 'Advanced', description: 'Every Hermes setting', phase: '11.9b' },
  { id: 'system', title: 'System', description: 'Service, backups, logs', phase: '11.9b' },
]

function isSettingsSection(value: string | undefined): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}

function Placeholder({ section }: { section: SettingsItem }) {
  return (
    <section className="settings-placeholder" aria-labelledby="settings-placeholder-title">
      <h2 id="settings-placeholder-title">{section.title}</h2>
      <p>Comes in {section.phase ?? '11.9b'}</p>
    </section>
  )
}

/** PLAN 11.9c: the bold shell's Settings frame. `/b/settings` opens Usage until the other sections land. */
export function BoldSettings() {
  const params = useParams()
  const navigate = useNavigate()
  const section = isSettingsSection(params.section) ? params.section : 'usage'
  // An unknown section is not silently Usage under its own name.
  if (params.section !== undefined && !isSettingsSection(params.section))
    return <Navigate to="/b/settings/usage" replace />
  const current = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[5]!

  return (
    <div className="page bold-settings-page">
      <div className="setgrid">
        <nav className="setnav" aria-label="Settings">
          <h1>Settings</h1>
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'on' : undefined}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => void navigate(`/b/settings/${item.id}`)}
            >
              <b>{item.title}</b>
              <span className="small muted">{item.description}</span>
            </button>
          ))}
          <button
            type="button"
            className="btn sm ghost settings-classic"
            onClick={() => {
              saveUi('classic')
              void navigate('/now')
            }}
          >
            Use the classic view
          </button>
        </nav>
        <div className="setmain">
          {section === 'usage' ? <BoldUsage /> : <Placeholder section={current} />}
        </div>
      </div>
    </div>
  )
}
