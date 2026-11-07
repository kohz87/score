import type { AgentQuestion, AgentSummary, Job } from '@score/contract'
import { QuestionCard } from './QuestionCard.tsx'

export function RoomQuestions({
  questions,
  jobs,
  agents,
}: {
  questions: AgentQuestion[]
  jobs: Job[]
  agents: AgentSummary[]
}) {
  return (
    <>
      {questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          agent={agents.find((item) => item.id === question.agentId)}
          jobTitle={jobs.find((item) => item.id === question.jobId)?.title}
        />
      ))}
    </>
  )
}
