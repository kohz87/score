import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

// What Score's bridge and adapter rely on inside Hermes, read from the installed Hermes sources (never executed:
// the script below only parses them with Python's `ast`). Mirrors scripts/hermes-drill-facts.py (PLAN 5.4).
export const BRIDGE_HOOKS = [
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_session_start',
  'on_session_end',
  'on_interim_message',
  'subagent_start',
  'subagent_stop',
  'on_human_input_request',
  'on_human_input_resolved',
  'on_kanban_worker_spawned',
  'on_kanban_worker_exited',
  'on_kanban_task_updated',
] as const
export const PRIVATE_APPROVAL_API = {
  functions: ['list_gateway_approvals', 'resolve_gateway_approval'],
  state: ['_gateway_queues', '_lock'],
  entrySlots: ['data', 'event', 'result'],
} as const

export const SourceFactsSchema = z.object({
  validHooks: z.array(z.string()),
  patternKeys: z.array(z.string()),
  approvalApi: z.object({
    functions: z.array(z.string()),
    state: z.array(z.string()),
    detectDangerousCommand: z.boolean(),
    entrySlots: z.array(z.string()),
  }),
})
export type SourceFacts = z.infer<typeof SourceFactsSchema>

const SCRIPT = String.raw`
import ast, json, sys
root = sys.argv[1]

def parse(path):
    with open(root + "/" + path, encoding="utf-8") as handle:
        return ast.parse(handle.read())

def assignment(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return node.value
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == name and node.value:
            return node.value
    raise SystemExit("missing " + name)

detection = parse("tools/approval_detection.py")
approval = parse("tools/approval.py")
wait = parse("tools/approval_gateway_wait.py")
plugins = parse("hermes_cli/plugins.py")
keys = sorted({e.elts[1].value for e in assignment(detection, "DANGEROUS_PATTERNS").elts
               if isinstance(e.elts[1], ast.Constant) and isinstance(e.elts[1].value, str)})
entry = next(n for n in ast.walk(wait) if isinstance(n, ast.ClassDef) and n.name == "_ApprovalEntry")
defined = {n.name for n in approval.body if isinstance(n, ast.FunctionDef)}
assigned = {t.id for n in approval.body if isinstance(n, (ast.Assign, ast.AnnAssign))
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]) if isinstance(t, ast.Name)}
print(json.dumps({
    "validHooks": sorted(e.value for e in assignment(plugins, "VALID_HOOKS").elts),
    "patternKeys": keys,
    "approvalApi": {
        "functions": sorted(n for n in ("list_gateway_approvals", "resolve_gateway_approval") if n in defined),
        "state": sorted(n for n in ("_lock", "_gateway_queues") if n in assigned),
        "detectDangerousCommand": any(isinstance(n, ast.FunctionDef) and n.name == "detect_dangerous_command"
                                      for n in detection.body),
        "entrySlots": sorted(ast.literal_eval(assignment(entry, "__slots__"))),
    },
}))
`

const execute = promisify(execFile)

/** Reads the facts from `<sourceDir>` (the Hermes checkout). Null when Python or a source file is unavailable. */
export async function readSourceFacts(sourceDir: string): Promise<SourceFacts | null> {
  try {
    const { stdout } = await execute('python3', ['-I', '-c', SCRIPT, sourceDir], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })
    return SourceFactsSchema.parse(JSON.parse(stdout))
  } catch {
    return null
  }
}

export const hermesSourceDir = (hermesHome: string) => join(hermesHome, 'hermes-agent')
