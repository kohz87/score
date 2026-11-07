import { WORKFLOW_LIMITS } from '@score/contract'
import { conditionFrom, conditionKey } from './node-inspector-helpers.ts'
import type { BranchNode, Commit, Patch } from './node-inspector-types.ts'
import { addRule, describeCondition, removeRule, updateRule, type Draft } from './workflow-model.ts'

export function NodeBranchSettings({
  draft,
  node,
  commit,
  patch,
}: {
  draft: Draft
  node: BranchNode
  commit: Commit
  patch: Patch
}) {
  const agentNodes = draft.nodes.filter((other) => other.kind === 'agent')

  return (
    <>
      <label className="orch-field">
        <span>Looks at</span>
        <select
          value={node.subject}
          aria-invalid={node.subject === '' ? true : undefined}
          onChange={(event) => patch({ subject: event.target.value })}
        >
          {node.subject === '' && <option value="">Choose an earlier agent step…</option>}
          {agentNodes.map((other) => (
            <option key={other.id} value={other.id}>
              {other.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="orch-field wf-rules">
        <legend>Rules, first match wins</legend>
        {node.rules.map((rule, index) => (
          <div key={rule.id} className="wf-rule">
            <span className="wf-rule__n">{index + 1}.</span>
            <select
              aria-label={`Rule ${index + 1} condition`}
              value={conditionKey(rule.when)}
              onChange={(event) =>
                commit(
                  updateRule(draft, node.id, rule.id, conditionFrom(event.target.value, rule.when)),
                )
              }
            >
              <option value="verdict:passed">the verdict is: passed</option>
              <option value="verdict:changes_requested">the verdict is: changes requested</option>
              <option value="outcome:succeeded">the step succeeded</option>
              <option value="outcome:failed">the step failed</option>
              <option value="output_contains">the output contains…</option>
            </select>
            {rule.when.kind === 'output_contains' && (
              <input
                aria-label={`Rule ${index + 1} text`}
                value={rule.when.text}
                maxLength={WORKFLOW_LIMITS.branchTextChars}
                onChange={(event) =>
                  commit(
                    updateRule(draft, node.id, rule.id, {
                      kind: 'output_contains',
                      text: event.target.value,
                    }),
                    `rule:${rule.id}`,
                  )
                }
              />
            )}
            <button
              type="button"
              className="wf-link"
              disabled={node.rules.length <= 1}
              aria-label={`Remove rule ${index + 1} (${describeCondition(rule.when)})`}
              onClick={() => commit(removeRule(draft, node.id, rule.id))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="wf-rule wf-rule--default">
          <span className="wf-rule__n">else</span>
          <span>otherwise (always needed)</span>
        </div>
        <button
          type="button"
          disabled={node.rules.length >= WORKFLOW_LIMITS.maxBranchRules}
          onClick={() => commit(addRule(draft, node.id))}
        >
          Add a rule
        </button>
        {node.rules.some((rule) => rule.when.kind === 'output_contains') && (
          <small className="orch-muted">
            “Output contains” looks at the saved output, which may be shortened, and ignores
            capitals. It is a hint to route on, never an approval.
          </small>
        )}
        {node.rules.some((rule) => rule.when.kind === 'verdict') && (
          <small className="orch-muted">
            A verdict exists only if the agent ends its reply with a score-verdict block. Otherwise
            the “otherwise” path is taken.
          </small>
        )}
      </fieldset>
    </>
  )
}
