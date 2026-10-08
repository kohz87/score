"""Extracts the Hermes facts Score depends on from one git revision of a hermes-agent clone (read-only).

Usage: python3 -I scripts/hermes-drill-facts.py <path/to/hermes-agent> <rev> [<rev> ...] > facts.json

Only `git show` is used, so the clone's working tree is never touched. The output is the fixture the upgrade
drill test reads (apps/server/test/fixtures/hermes/upgrade-drill-facts.json): data strings and names, no code.
"""

import ast
import hashlib
import json
import re
import subprocess
import sys


def show(repo: str, rev: str, path: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, "show", f"{rev}:{path}"], capture_output=True, text=True, check=True
    ).stdout


def assignment(tree: ast.AST, name: str):
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return node.value
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == name and node.value:
            return node.value
    return None


def digest(text: str) -> str:
    return hashlib.sha256(re.sub(r"\s+", " ", text).strip().encode()).hexdigest()


def descriptions(value) -> list[str]:
    out = []
    for element in value.elts:
        second = element.elts[1]
        if not (isinstance(second, ast.Constant) and isinstance(second.value, str)):
            raise SystemExit(f"non-literal pattern description: {ast.unparse(second)}")
        out.append(second.value)
    return sorted(set(out))


def facts(repo: str, rev: str) -> dict:
    detection = ast.parse(show(repo, rev, "tools/approval_detection.py"))
    approval = ast.parse(show(repo, rev, "tools/approval.py"))
    wait = ast.parse(show(repo, rev, "tools/approval_gateway_wait.py"))
    api = ast.parse(show(repo, rev, "gateway/platforms/api_server.py"))
    plugins = ast.parse(show(repo, rev, "hermes_cli/plugins.py"))
    common = ast.parse(show(repo, rev, "hermes_state_common.py"))
    kanban = ast.parse(show(repo, rev, "hermes_cli/kanban_db.py"))
    flags = assignment(api, "_STATIC_FEATURE_FLAGS")
    handler = next(
        n for n in ast.walk(api) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_handle_capabilities"
    )
    features = next(
        n
        for n in ast.walk(handler)
        if isinstance(n, ast.Dict)
        and any(isinstance(k, ast.Constant) and k.value == "run_submission" for k in n.keys)
    )
    advertised = {
        k.value
        for k, v in list(zip(flags.keys, flags.values)) + list(zip(features.keys, features.values))
        if isinstance(k, ast.Constant) and isinstance(v, ast.Constant) and v.value is True
    }
    entry = next(n for n in ast.walk(wait) if isinstance(n, ast.ClassDef) and n.name == "_ApprovalEntry")
    defined = {n.name for n in approval.body if isinstance(n, ast.FunctionDef)}
    assigned = {
        t.id
        for n in approval.body
        if isinstance(n, (ast.Assign, ast.AnnAssign))
        for t in (n.targets if isinstance(n, ast.Assign) else [n.target])
        if isinstance(t, ast.Name)
    }
    return {
        "sha": subprocess.run(
            ["git", "-C", repo, "rev-parse", rev], capture_output=True, text=True, check=True
        ).stdout.strip(),
        "schemas": {
            "kanbanSchemaSql": digest(ast.literal_eval(assignment(kanban, "SCHEMA_SQL"))),
            "stateSchemaSql": digest(ast.literal_eval(assignment(common, "SCHEMA_SQL"))),
            "stateSchemaVersion": ast.literal_eval(assignment(common, "SCHEMA_VERSION")),
        },
        "capabilities": sorted(advertised),
        "validHooks": sorted(e.value for e in assignment(plugins, "VALID_HOOKS").elts),
        "dangerousPatternKeys": descriptions(assignment(detection, "DANGEROUS_PATTERNS")),
        "hardlinePatternKeys": descriptions(assignment(detection, "HARDLINE_PATTERNS")),
        "approvalApi": {
            "functions": sorted(
                name for name in ("list_gateway_approvals", "resolve_gateway_approval") if name in defined
            ),
            "state": sorted(name for name in ("_lock", "_gateway_queues") if name in assigned),
            "detectDangerousCommand": any(
                isinstance(n, ast.FunctionDef) and n.name == "detect_dangerous_command"
                for n in detection.body
            ),
            "entrySlots": sorted(ast.literal_eval(assignment(entry, "__slots__"))),
        },
    }


def main() -> None:
    repo, revs = sys.argv[1], sys.argv[2:]
    print(json.dumps({rev: facts(repo, rev) for rev in revs}, indent=2, sort_keys=True))


main()
