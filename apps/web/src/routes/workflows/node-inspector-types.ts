import type { WorkflowNode } from '@score/contract'
import type { Draft } from './workflow-model.ts'

export type Commit = (next: Draft, coalesce?: string) => void
export type Patch = (change: Partial<WorkflowNode>, coalesce?: string) => void
export type AgentNode = Extract<WorkflowNode, { kind: 'agent' }>
export type GateNode = Extract<WorkflowNode, { kind: 'gate' }>
export type BranchNode = Extract<WorkflowNode, { kind: 'branch' }>
