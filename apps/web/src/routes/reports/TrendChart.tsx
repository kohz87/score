import type { Reports } from '@score/contract'
import './trend-chart.css'

const WIDTH = 700
const PLOT_TOP = 16
const PLOT_HEIGHT = 168
const LABEL_HEIGHT = 28
const HEIGHT = PLOT_TOP + PLOT_HEIGHT + LABEL_HEIGHT

type Props = { trend: Reports['trend']; money: (usd: number | null) => string }

/** 30 days of runs (bars, left scale) and model spend (line with round markers, right scale). Days without a cost
 * reading break the line: unknown is not zero. A table below gives the same numbers to screen readers. */
export function TrendChart({ trend, money }: Props) {
  const maxRuns = Math.max(1, ...trend.map((day) => day.runs))
  const maxSpend = Math.max(0.01, ...trend.map((day) => day.spendUsd ?? 0))
  const slot = trend.length > 0 ? WIDTH / trend.length : WIDTH
  const barWidth = Math.max(2, slot - Math.min(10, slot * 0.4))
  const baseline = PLOT_TOP + PLOT_HEIGHT
  const centre = (index: number) => index * slot + slot / 2
  const spendY = (usd: number) => baseline - (usd / maxSpend) * PLOT_HEIGHT
  const totalRuns = trend.reduce((sum, day) => sum + day.runs, 0)
  const knownSpend = trend.filter((day) => day.spendUsd !== null)
  const totalSpend = knownSpend.reduce((sum, day) => sum + (day.spendUsd ?? 0), 0)
  const summary = `Last ${trend.length} days: ${totalRuns} runs${
    knownSpend.length > 0
      ? `, ${money(totalSpend)} spend on the ${knownSpend.length} days with a cost reading`
      : ', spend unknown'
  }.`
  // Segments of consecutive known days, so a gap is a real gap.
  const segments: { x: number; y: number }[][] = []
  trend.forEach((day, index) => {
    if (day.spendUsd === null) {
      segments.push([])
      return
    }
    if (segments.length === 0) segments.push([])
    segments.at(-1)!.push({ x: centre(index), y: spendY(day.spendUsd) })
  })
  const label = (date: string, index: number) => (index % 5 === 0 ? date.slice(5) : '')

  return (
    <div className="trend">
      <ul className="trend__legend" aria-label="Legend">
        <li>
          <span className="trend__swatch trend__swatch--bar" aria-hidden="true" />
          Runs (left, most {maxRuns})
        </li>
        <li>
          <span className="trend__swatch trend__swatch--line" aria-hidden="true" />
          Spend (right, most {money(maxSpend)})
        </li>
      </ul>
      <div
        className="trend__scroll"
        role="region"
        aria-label="30-day trend chart, scroll to see all days"
        tabIndex={0}
      >
        <svg
          className="trend__svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          data-testid="trend-svg"
        >
          <line className="trend__grid" x1={0} x2={WIDTH} y1={baseline} y2={baseline} />
          <line
            className="trend__grid"
            x1={0}
            x2={WIDTH}
            y1={PLOT_TOP}
            y2={PLOT_TOP}
            strokeDasharray="4 4"
          />
          {trend.map((day, index) => {
            const height = (day.runs / maxRuns) * PLOT_HEIGHT
            return (
              <g key={day.date} data-trend-day={day.date}>
                {day.runs > 0 && (
                  <rect
                    className="trend__bar"
                    x={centre(index) - barWidth / 2}
                    y={baseline - height}
                    width={barWidth}
                    height={height}
                    rx={Math.min(4, barWidth / 2)}
                  />
                )}
                <text className="trend__label" x={centre(index)} y={baseline + 20}>
                  {label(day.date, index)}
                </text>
              </g>
            )
          })}
          {segments.map(
            (points, index) =>
              points.length > 1 && (
                <polyline
                  key={index}
                  className="trend__line"
                  points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                />
              ),
          )}
          {segments.flat().map((point) => (
            <circle key={point.x} className="trend__dot" cx={point.x} cy={point.y} r={3.5} />
          ))}
        </svg>
      </div>
      <table className="trend__sr-only">
        <caption>Runs and spend per day, last {trend.length} days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Runs</th>
            <th scope="col">Spend</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{day.runs}</td>
              <td>{money(day.spendUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
