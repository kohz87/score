import { useStreamQuery } from '../data/query-client.ts'
import { questionInRoom, questionNeedsYou, questionsQuery } from '../data/question-queries.ts'
import { approvalsQuery } from '../routes/chat/queries.ts'
import { approvalInRoom, approvalNeedsYou } from './room/room-model.ts'
import { teamRoomQuery } from './room/room-queries.ts'

/**
 * Decision 184: the approvals and agent questions waiting on the person in any chat other than the team room. With the
 * dock gone, the Chats button adds them to the team room's own count, so every page says when something waits anywhere.
 * Items, not chats: one question counts once, however many rows show it.
 */
export function useNeedsElsewhere(): number {
  const teamId = useStreamQuery(teamRoomQuery(null)).data?.room.id ?? null
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const questions = useStreamQuery(questionsQuery).data ?? []
  if (teamId === null) return 0
  return (
    approvals.filter((approval) => approvalNeedsYou(approval) && !approvalInRoom(approval, teamId))
      .length +
    questions.filter(
      (question) => questionNeedsYou(question) && !questionInRoom(question, teamId, true),
    ).length
  )
}
