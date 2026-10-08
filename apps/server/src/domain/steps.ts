import { createHash } from 'node:crypto'
import { TaskStepSchema, type TaskStep } from '@score/contract'
import { z } from 'zod'

const checklist = /^( {0,3}[-*] \[)([ xX])(\] )(.*)$/

function block(body: string) {
  const lines = [...body.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)].filter((line) => line[0] !== '')
  const start = lines.findIndex((line) => checklist.test(line[1]!))
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && checklist.test(lines[end]![1]!)) end++
  return lines.slice(start, end)
}

// Only the first contiguous checklist is the task's steps; later lists remain body content.
export function parseSteps(body: string): TaskStep[] {
  return (block(body) ?? []).map((line, position) => {
    const match = checklist.exec(line[1]!)!
    const text = match[4]!
    return {
      id: createHash('sha256').update(`${position}:${text}`).digest('hex').slice(0, 16),
      text,
      done: match[2]!.toLowerCase() === 'x',
    }
  })
}

export function writeSteps(body: string, input: TaskStep[]): string {
  const steps = z.array(TaskStepSchema).parse(input)
  if (steps.some((step) => /[\r\n\0]/.test(step.text)))
    throw new Error('Step text must be a single line')
  const lines = block(body)
  if (!lines) {
    if (!steps.length) return body
    const newline = /\r\n|\n|\r/.exec(body)?.[0] ?? '\n'
    const separator = body && !/[\r\n]$/.test(body) ? newline : ''
    return (
      body +
      separator +
      steps.map((step) => `- [${step.done ? 'x' : ' '}] ${step.text}`).join(newline)
    )
  }
  const first = lines[0]!
  const last = lines.at(-1)!
  const newline = lines.find((line) => line[2])?.[2] ?? /\r\n|\n|\r/.exec(body)?.[0] ?? '\n'
  const rendered = steps
    .map((step, index) => {
      const original = lines[index]
      const match = original && checklist.exec(original[1]!)
      const marker = step.done ? (match?.[2]?.toLowerCase() === 'x' ? match[2] : 'x') : ' '
      const text = match
        ? `${match[1]}${marker}${match[3]}${step.text}`
        : `- [${marker}] ${step.text}`
      return text + (index < steps.length - 1 ? original?.[2] || newline : last[2])
    })
    .join('')
  return body.slice(0, first.index) + rendered + body.slice(last.index! + last[0].length)
}
