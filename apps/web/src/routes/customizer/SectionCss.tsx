import { THEME_CSS_ALLOWED } from '@score/contract'
import { CodeEditor } from '../../components/CodeEditor.tsx'
import { describeDropped, reportSummary } from '../../themes/customizer/report-text.ts'
import { setCss } from '../../themes/customizer/draft.ts'
import type { SectionContext } from './section-context.ts'

const LIMIT = 262_144

export function SectionCss({ draft, edit, report }: SectionContext) {
  const lines = describeDropped(report)
  const bytes = new TextEncoder().encode(draft.css).length
  return (
    <div className="cz-section">
      <p className="cz-note">
        Free CSS for anything the other sections can’t reach. It goes through the same checks as an
        installed theme: the checks run as you type, and whatever they remove is listed below. A
        theme’s CSS can’t reach approvals or security screens, and it can only change how things
        look: colours, backgrounds, borders, shadows, fonts and opacity. Where things sit and how
        big they are comes from the Layout section.
      </p>
      <details className="cz-note cz-allowed">
        <summary>What a declaration may set</summary>
        <ul>
          {THEME_CSS_ALLOWED.map((group) => (
            <li key={group.group}>
              <strong>{group.group}:</strong> <code>{group.properties.join(', ')}</code>
            </li>
          ))}
        </ul>
      </details>
      <div className="cz-code">
        <CodeEditor
          value={draft.css}
          path="theme.css"
          label="Custom CSS"
          onChange={(text) => edit(setCss(draft, text), 'css')}
        />
      </div>
      <p className="cz-note" data-over={bytes > LIMIT || undefined}>
        {bytes.toLocaleString('en-GB')} of {LIMIT.toLocaleString('en-GB')} bytes
      </p>
      <section className="cz-report" aria-label="What the checks removed" aria-live="polite">
        <h3>{reportSummary(report)}</h3>
        {lines.length > 0 && (
          <ul>
            {lines.map((line, index) => (
              <li key={`${index}:${line.rule}`}>
                <code>{line.rule}</code>
                <span>{line.why}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
