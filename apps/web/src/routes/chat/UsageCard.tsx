import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import type { UsageCardData } from './usage-card.ts'
import '../../bold/quota/bold-quota.css'

/**
 * The coding agent's `/usage` card: this session, then the plan quota with a bar per window. Its plain-text twin
 * (`codingUsageSummary`) is the accessible fallback: the card is for the eye, so it is hidden from screen readers.
 */
export function UsageCard({ card, fallback }: { card: UsageCardData; fallback: string }) {
  const resets = (card.quota.kind === 'windows' ? card.quota.windows : [])
    .filter((window) => window.resets)
    .map((window) => `${window.title} resets ${window.resets}`)
  return (
    <>
      <span className="sr-only" data-testid="usage-fallback">
        {fallback}
      </span>
      <section className="bold-usage-card" aria-hidden="true">
        <header className="bold-usage-head">
          {card.agent && <AgentGlyph agent={card.agent} size="sm" decorative />}
          <b>{card.name} · usage</b>
        </header>
        <div className="bold-usage-blocks">
          <div className="bold-usage-block">
            <span className="bold-usage-kicker">THIS SESSION</span>
            <span>
              {card.tokens ? <b>{card.tokens}</b> : 'No usage reported yet'}
              {card.contextPercent !== null && (
                <>
                  {' · context '}
                  <b>{card.contextPercent}%</b>
                  {' full'}
                </>
              )}
            </span>
            <span className="bold-usage-sub">
              {card.costUsd === null
                ? 'Plan usage, so no dollar cost'
                : `$${card.costUsd.toFixed(4)}`}
            </span>
          </div>
          <div className="bold-usage-block">
            <span className="bold-usage-kicker">{card.planTitle}</span>
            {card.quota.kind === 'message' ? (
              <span className="bold-usage-sub">{card.quota.text}</span>
            ) : (
              <>
                {card.quota.windows.map((window) => (
                  <div className="bold-usage-row" key={window.title}>
                    <span className="bold-usage-name">{window.title}</span>
                    {window.exact !== null ? (
                      <span className="bold-quota-info-track" data-tone={window.tone}>
                        <span className="bold-quota-fill" style={{ width: `${window.exact}%` }} />
                      </span>
                    ) : (
                      <span className="bold-usage-gap" />
                    )}
                    <b>{window.left === null ? 'not reported' : `${window.left}% left`}</b>
                  </div>
                ))}
                <span className="bold-usage-sub">{[...resets, card.quota.read].join(' · ')}</span>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  )
}
