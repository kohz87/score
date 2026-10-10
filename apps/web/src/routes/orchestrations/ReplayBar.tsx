export const SPEEDS = [1, 4, 16] as const
export type Speed = (typeof SPEEDS)[number]

/** Play / step / scrub / speed for a replay of a run's recorded events (orchestrations and workflow runs). */
export function ReplayBar({
  total,
  count,
  playing,
  speed,
  at,
  onCount,
  onPlaying,
  onSpeed,
}: {
  total: number
  count: number
  playing: boolean
  speed: Speed
  at: string | null
  onCount: (n: number) => void
  onPlaying: (playing: boolean) => void
  onSpeed: (speed: Speed) => void
}) {
  return (
    <div className="orch-replay" role="group" aria-label="Replay">
      <button
        type="button"
        onClick={() => onCount(Math.max(0, count - 1))}
        disabled={count <= 0}
        aria-label="Step back"
      >
        ◀︎
      </button>
      <button
        type="button"
        className="orch-primary"
        onClick={() => {
          if (count >= total) {
            onCount(0)
            onPlaying(true)
          } else onPlaying(!playing)
        }}
      >
        {playing ? 'Pause' : count >= total ? 'Replay again' : 'Play'}
      </button>
      <button
        type="button"
        onClick={() => onCount(Math.min(total, count + 1))}
        disabled={count >= total}
        aria-label="Step forward"
      >
        ▶︎
      </button>
      <input
        type="range"
        min={0}
        max={total}
        value={count}
        aria-label="Replay position"
        aria-valuetext={`Event ${count} of ${total}${at ? `, ${new Date(at).toLocaleTimeString()}` : ''}`}
        onChange={(event) => {
          onPlaying(false)
          onCount(Number(event.target.value))
        }}
      />
      <span className="orch-muted" aria-live="off">
        {count} / {total}
      </span>
      <span role="radiogroup" aria-label="Replay speed" className="orch-speeds">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={speed === value}
            className={speed === value ? 'orch-on' : undefined}
            onClick={() => onSpeed(value)}
          >
            {value}×
          </button>
        ))}
      </span>
    </div>
  )
}
