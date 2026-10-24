import { Navigate, useNavigate, useParams } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import { AdvancedSection } from '../routes/settings/AdvancedSection.tsx'
import { NotificationsSection } from '../routes/settings/NotificationsSection.tsx'
import { RulesSection } from '../routes/settings/RulesSection.tsx'
import { HermesVersionBanner } from '../routes/settings/HermesVersionBanner.tsx'
import { agentsQuery } from '../routes/team/team-queries.ts'
import { BoldSecurity } from './BoldSecurity.tsx'
import { BoldConnections } from './BoldConnections.tsx'
import { BoldLook } from './BoldLook.tsx'
import { BoldSystem } from './BoldSystem.tsx'
import { BoldTools } from './BoldTools.tsx'
import { BoldUsage } from './BoldUsage.tsx'
import { saveUi } from './bold-ui.ts'
import '../routes/settings/settings.css'
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

function Section({
  section,
  agents,
}: {
  section: SettingsSection
  agents: ReturnType<typeof useAgents>
}) {
  switch (section) {
    case 'connections':
      return <BoldConnections agents={agents} />
    case 'tools':
      return <BoldTools agents={agents} />
    case 'look':
      return <BoldLook />
    case 'rules':
      return <RulesSection agents={agents} heading="Rules" />
    case 'notifications':
      return <NotificationsSection />
    case 'security':
      return <BoldSecurity />
    case 'advanced':
      return <AdvancedSection />
    case 'system':
      return <BoldSystem />
    case 'usage':
      return <BoldUsage />
    default:
      return <BoldUsage />
  }
}

function useAgents() {
  return useStreamQuery(agentsQuery).data ?? []
}

/** PLAN 11.9a–c: the bold shell's Settings frame. */
export function BoldSettings() {
  const params = useParams()
  const navigate = useNavigate()
  const agents = useAgents()
  const section = isSettingsSection(params.section) ? params.section : 'usage'
  // An unknown section is not silently Usage under its own name.
  if (params.section !== undefined && !isSettingsSection(params.section))
    return <Navigate to="/b/settings/usage" replace />
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
          <HermesVersionBanner />
          <Section section={section} agents={agents} />
        </div>
      </div>
    </div>
  )
}
