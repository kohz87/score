import type { ToolName } from './command-args.ts'
import { assignCommand } from './command-assign.ts'
import { checkCommand, finishCommand, receiptCommand } from './command-finish.ts'
import { planCommand } from './command-plan.ts'
import { cancelCommand, requestApprovalCommand } from './command-steps.ts'
import type { Handler } from './command-support.ts'
import { askCommand, noteCommand } from './command-talk.ts'
import { voteCommand } from './command-vote.ts'

export const HANDLERS: Record<ToolName, Handler> = {
  'orch.vote': voteCommand,
  'orch.plan': planCommand,
  'orch.assign': assignCommand,
  'orch.requestApproval': requestApprovalCommand,
  'orch.cancel': cancelCommand,
  'orch.ask': askCommand,
  'orch.note': noteCommand,
  'orch.check': checkCommand,
  'orch.finish': finishCommand,
  'orch.receipt': receiptCommand,
}
