import { useContext } from 'react'
import { StreamContext } from '../../data/query-client.ts'
import { Polled, Streamed } from './ContextMeterSource.tsx'
import type { MeterProps } from './context-meter-types.ts'

export { ringLevel } from './ContextMeterRing.tsx'

/**
 * A ring per agent in the composer footer (PLAN 5.36): how full the agent's context window is, with a popover that says
 * what uses it (Hermes's own accounting when the bridge can answer) and a Compact button. Inside the app the reading
 * follows the stream (`session.compacted`); without a stream connection (unit tests) it is a plain query.
 */
export function ContextMeter(props: MeterProps) {
  return useContext(StreamContext) ? <Streamed {...props} /> : <Polled {...props} />
}
