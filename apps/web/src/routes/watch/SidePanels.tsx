import type { WatchOverviewItem } from '@score/contract'

export function ScreenMiniature({ item }: { item: WatchOverviewItem }) {
  if (item.thumbnail)
    return (
      <img className="watch-mini__img" src={item.thumbnail} alt={`${item.agent.name}’s screen`} />
    )
  if (!item.live && item.surface === null)
    return <span className="watch-mini__empty">No desktop open</span>
  if (item.surface === 'browser')
    return (
      <>
        <span className="watch-mini__page" />
        <span className="watch-mini__line" style={{ left: '12%', top: '30%', width: '40%' }} />
        <span className="watch-mini__line" style={{ left: '12%', top: '44%', width: '28%' }} />
      </>
    )
  return (
    <>
      <span className="watch-mini__window" />
      <span
        className="watch-mini__line watch-mini__line--hot"
        style={{ left: '12%', top: '28%', width: '40%' }}
      />
      <span className="watch-mini__line" style={{ left: '12%', top: '40%', width: '48%' }} />
      <span className="watch-mini__line" style={{ left: '12%', top: '50%', width: '36%' }} />
      {item.surface === 'editor' && <span className="watch-mini__page watch-mini__page--small" />}
    </>
  )
}
