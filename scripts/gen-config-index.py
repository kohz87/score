"""Regenerates apps/server/src/hermes/live/config-index.json from Hermes's config defaults.

Usage: python3 -I scripts/gen-config-index.py <path/to/hermes_cli/config_defaults.py> [out.json]

The index holds key names, descriptions (the comments above each key in DEFAULT_CONFIG) and
literal defaults. Adapted from NousResearch/hermes-agent hermes_cli/config_defaults.py
(Copyright (c) 2025 Nous Research, MIT; see THIRD_PARTY_NOTICES.md). No values from a user's
config and nothing secret goes in: secret-bearing keys are filtered at runtime in TypeScript.
"""

import ast
import io
import json
import re
import sys
import tokenize

# AGENTS.md rule 5: the owner's persona names never ship, not even where Hermes uses them as voice names.
PERSONA = re.compile("akeno|fern|makima|marin", re.IGNORECASE)
AUX_KEYS = ["provider", "model", "base_url", "api_key", "timeout", "extra_body"]


def main() -> None:
    source_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else "apps/server/src/hermes/live/config-index.json"
    with open(source_path, encoding="utf-8") as handle:
        source = handle.read()
    tree = ast.parse(source)

    own_line: dict[int, str] = {}
    trailing: dict[int, str] = {}
    lines = source.splitlines()
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type != tokenize.COMMENT:
            continue
        text = tok.string.lstrip("#").strip()
        row = tok.start[0]
        if lines[row - 1].strip().startswith("#"):
            own_line[row] = text
        else:
            trailing[row] = text

    def describe(line: int) -> str | None:
        parts: list[str] = []
        row = line - 1
        while row in own_line:
            parts.insert(0, own_line[row])
            row -= 1
        if line in trailing:
            parts.append(trailing[line])
        text = " ".join(part for part in parts if part)
        return text or None

    def literal(node: ast.AST):
        try:
            value = ast.literal_eval(node)
            json.dumps(value)
            return True, value
        except Exception:
            return False, None

    entries: list[dict] = []

    def add(path: list[str], line: int, node: ast.AST | None) -> None:
        entry: dict = {"key": ".".join(path)}
        description = describe(line)
        if description:
            entry["description"] = description
        if node is not None:
            ok, value = literal(node)
            if ok:
                entry["default"] = value
        if PERSONA.search(json.dumps(entry)):
            entry.pop("description", None)
            entry.pop("default", None)
        entries.append(entry)

    def walk(node: ast.Dict, prefix: list[str]) -> None:
        for key, value in zip(node.keys, node.values):
            if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
                continue  # spreads and computed keys carry no stable name
            path = prefix + [key.value]
            if isinstance(value, ast.Dict) and value.keys:
                walk(value, path)
            elif isinstance(value, ast.Call) and getattr(value.func, "id", "") == "_aux":
                effort = True
                extras: list[str] = []
                for kw in value.keywords:
                    if kw.arg == "reasoning_effort" and isinstance(kw.value, ast.Constant):
                        effort = bool(kw.value.value)
                    elif kw.arg and kw.arg != "reasoning_effort":
                        extras.append(kw.arg)
                names = AUX_KEYS + (["reasoning_effort"] if effort else []) + extras
                for name in names:
                    add(path + [name], key.lineno, None)
            else:
                add(path, key.lineno, value)

    root = next(
        node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "DEFAULT_CONFIG"
    )
    walk(root, [])
    entries.sort(key=lambda entry: entry["key"])
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {"generatedFrom": "hermes_cli/config_defaults.py", "entries": entries},
            handle,
            indent=2,
            ensure_ascii=False,
        )
        handle.write("\n")
    print(f"{len(entries)} keys -> {out_path}")


main()
