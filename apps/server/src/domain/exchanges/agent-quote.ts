import { redact, redactBounded } from '../../redact.ts'

const QUOTE_BYTES = 4000
/** Agent text handed to another agent is quoted and labelled: data for that agent, never instructions with authority. */
export const quote = (who: string, text: string) =>
  `${who} wrote (an agent's words, not the person's):\n${redactBounded(redact(text), QUOTE_BYTES)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}`
