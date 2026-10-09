import type { JourneyFacts } from '../../domain/journey.ts'
import type { KanbanTaskFact } from '../../domain/reports.ts'

const HOUR = 3_600_000
const DAY = 86_400_000

const TASK_TITLES = [
  'Tidy the onboarding copy',
  'Add pagination to the activity feed',
  'Review the release checklist',
  'Fix the empty state on Tasks',
  'Draft the weekly summary',
  'Speed up the search index',
  'Check the colour contrast',
  'Write tests for the export',
]
const SKILLS = ['summarize-thread', 'release-notes', 'code-review', 'design-critique', 'triage']
const NOTES = [
  'Launch plan',
  'Onboarding decisions',
  'Release retro',
  'Design tokens',
  'Review checklist',
]

function hash(text: string): number {
  let h = 2166136261
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return h >>> 0
}

/**
 * Deterministic demo marks per agent over the last 30 days: skill and memory file changes and notes are spread by
 * a hash of the agent and day, so the same day always draws the same picture. Names are neutral.
 */
export function fakeJourneyFacts(
  to: number,
  agentIds: string[],
  tasks: KanbanTaskFact[],
): JourneyFacts {
  const today = Math.floor(to / DAY) * DAY
  const facts: JourneyFacts = { tasks: [], skills: [], memory: [], notes: [] }
  for (const task of tasks) {
    if (task.completedAt === null || !task.assignee) continue
    facts.tasks.push({
      agentId: task.assignee,
      at: task.completedAt,
      id: task.id,
      title: TASK_TITLES[hash(task.id) % TASK_TITLES.length]!,
    })
  }
  for (const agentId of agentIds) {
    for (let back = 29; back >= 0; back--) {
      const day = today - back * DAY
      const roll = hash(`${agentId}:${day / DAY}`)
      const at = (hours: number) => day + (hours % 24) * HOUR
      if (roll % 11 === 0)
        facts.skills.push({
          agentId,
          at: at(10 + (roll % 6)),
          name: SKILLS[(roll >>> 3) % SKILLS.length]!,
        })
      if (roll % 5 === 1) facts.memory.push({ agentId, at: at(14 + (roll % 5)) })
      if (roll % 7 === 2) {
        const title = NOTES[(roll >>> 5) % NOTES.length]!
        facts.notes!.push({
          agentId,
          at: at(11 + (roll % 5)),
          title,
          path: `${title.toLowerCase().replace(/\s+/g, '-')}.md`,
        })
      }
    }
  }
  return facts
}
