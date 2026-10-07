"""Bound capture work, then redact plain data before serialization or truncation."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable

_REDACTED = "[redacted]"
LEAF_CAP = 16_384
PAYLOAD_CAP = 64 * 1024
_NAMES = ("password", "passwd", "secret", "token", "apikey", "accesskey", "privatekey",
          "clientsecret", "authorization", "cookie", "credential", "sessionid")
_ASSIGNMENT = re.compile(
    r'''(?<![\w-])(["']?([\w-]+(?: +[\w-]+){0,3})["']?\s*[=:]\s*)(?!\[redacted\])("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)''', re.I)
_PATTERNS = (
    (re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)"), _REDACTED),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.I), "Bearer [redacted]"),
    (re.compile(r"\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b"), _REDACTED),
    (re.compile(r"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{8,}\b"), _REDACTED),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), _REDACTED),
    (re.compile(r'''(\b(?:key|token|secret|password)["']?\s*(?:[=:]\s*|\s+)["']?)[A-Za-z0-9_-]{32,}=*''', re.I), r"\1[redacted]"),
)


def credential_key(key: str) -> bool:
    name = key.lower().translate(str.maketrans("", "", "_- "))
    return any(part in name for part in _NAMES) or name in ("awssecretaccesskey", "awsaccesskeyid", "xapikey")


def local_redact(text: str) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return _ASSIGNMENT.sub(lambda m: m[1] + _REDACTED if credential_key(m[2]) else m[0], text)


def digest(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8", errors="surrogatepass")).hexdigest()


def snapshot(value: object) -> object:
    remaining = 2000
    seen: set[int] = set()

    def walk(item, depth=0):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 8:
            return "[omitted]"
        kind = type(item)
        if kind is str:
            return item if len(item) <= LEAF_CAP else f"[omitted: {len(item)} chars]"
        if item is None or (kind is bool or kind is int):
            # JSON's integer conversion is also work; bound pathological bigints.
            return "[omitted: integer]" if kind is int and item.bit_length() > 4096 else item
        if kind is float:
            return item if math.isfinite(item) else None
        if kind is not dict and kind is not list and kind is not tuple:
            # Bypass foreign __repr__, __str__, iteration and metaclass attribute hooks.
            return "<" + type.__dict__["__name__"].__get__(kind)[:100] + ">"
        if depth >= 8:
            return "[omitted]"
        if id(item) in seen:
            return "[circular]"
        seen.add(id(item))
        try:
            if kind is dict:
                result = {}
                for key, child in item.items():
                    if remaining < 3:
                        if remaining >= 2:
                            result["omitted"] = "[omitted]"
                            remaining -= 2
                        break
                    remaining -= 1
                    if type(key) is not str or len(key) > LEAF_CAP or key.startswith("_"):
                        continue
                    result[key] = walk(child, depth + 1)
                return result
            result = []
            for child in item:
                if remaining <= 1:
                    if remaining == 1:
                        result.append("[omitted]")
                        remaining -= 1
                    break
                result.append(walk(child, depth + 1))
            return result
        finally:
            seen.remove(id(item))
    return walk(value)


def scrub(value: object, redact_fn: Callable[[str], str]) -> object:
    def text(raw, limit):
        try:
            safe = redact_fn(raw)
            if type(safe) is not str:
                return _REDACTED
        except Exception:
            safe = raw
        if len(safe) > LEAF_CAP:
            return f"[omitted: {len(safe)} chars]"
        return local_redact(safe)[:limit]

    def walk(item, limit=4096):
        if type(item) is str:
            return text(item, limit)
        if type(item) is dict:
            return {text(key, 4096): _REDACTED if credential_key(key) else
                    walk(child, 16384 if key == "result" else limit)
                    for key, child in item.items() if not key.startswith("_")}
        if type(item) is list:
            return [walk(child, limit) for child in item]
        return item
    return bound_payload(walk(snapshot(value)))


def bound_payload(value):
    # Replace the largest strings first; include keys and JSON escaping in the budget.
    leaves = []
    def collect(item):
        if type(item) is dict:
            for key, child in item.items():
                if type(child) is str:
                    leaves.append((len(json.dumps(child)), item, key))
                else:
                    collect(child)
        elif type(item) is list:
            for index, child in enumerate(item):
                if type(child) is str:
                    leaves.append((len(json.dumps(child)), item, index))
                else:
                    collect(child)
    collect(value)
    def serialized_size(item):
        if type(item) is dict:
            return 2 + max(0, len(item) - 1) + sum(len(json.dumps(key)) + 1 + serialized_size(child)
                                                for key, child in item.items())
        if type(item) is list:
            return 2 + max(0, len(item) - 1) + sum(serialized_size(child) for child in item)
        return len(json.dumps(item, ensure_ascii=True, allow_nan=False))
    size = serialized_size(value)
    for length, parent, key in sorted(leaves, key=lambda entry: entry[0], reverse=True):
        if size <= PAYLOAD_CAP:
            break
        marker = f"[omitted: {len(parent[key])} chars]"
        parent[key] = marker
        size -= length - len(json.dumps(marker))
    if size > PAYLOAD_CAP:
        return {"omitted": "[omitted: payload exceeds 65536 bytes]"}
    return value
