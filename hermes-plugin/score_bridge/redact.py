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
# Terminal output keeps its tail: the last LEAF_CAP characters, taken from LEAF_CAP + TAIL_MARGIN raw characters so a
# secret that straddles the cut is redacted whole before the margin is dropped.
TAIL_MARGIN = 4096
_LONG_KEYS = frozenset(("content", "patch", "old_string", "new_string", "diff"))
# Tools whose arguments or results can carry credentials: only the tool name and status leave the process.
_SENSITIVE_TOOL = re.compile(r"vault|credential|secret|passw(?:or)?d|keychain|api[_-]?key", re.I)
_CREDENTIAL_PATH = re.compile(
    r"(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials(?:\.[^\\/]*)?"
    r"|id_(?:rsa|dsa|ecdsa|ed25519)|[^\\/]*\.(?:pem|key|p12|pfx|keystore))$", re.I)
_PATCH_PATHS = re.compile(r"^(?:\*\*\* (?:Update|Add|Delete) File:|\*\*\* Move to:|---|\+\+\+)\s+(?:[ab]/)?(\S.*?)\s*$", re.M)
_NAMES = ("password", "passwd", "secret", "token", "apikey", "accesskey", "privatekey",
          "clientsecret", "authorization", "cookie", "credential")
_ASSIGNMENT = re.compile(
    r'''(?<![\w-])(["']?([\w-]+(?: +[\w-]+){0,3})["']?\s*[=:]\s*)(?!\[redacted\])("[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}\]]+)''', re.I)
_PATTERNS = (
    # URL query secrets and userinfo: the assignment pass below would otherwise swallow "https:" + the whole URL.
    (re.compile(r"""([?&;][\w.-]*?(?:token|key|secret|passw(?:or)?d|auth|sig|signature|credential|session|cookie)[\w.-]*=)[^&\s#"'<>]+""", re.I), r"\1[redacted]"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+@", re.I), r"\1[redacted]@"),
    (re.compile(r"(\bAuthorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*", re.I), r"\1[redacted]"),
    (re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)"), _REDACTED),
    # An END left after that has lost its BEGIN (a tail window cut through the key): what precedes it is key body.
    (re.compile(r"\A[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----"), _REDACTED),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.I), "Bearer [redacted]"),
    (re.compile(r"\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b"), _REDACTED),
    (re.compile(r"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{8,}\b"), _REDACTED),
    (re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"), _REDACTED),
    (re.compile(r'''(\b(?:key|token|secret|password)["']?\s*(?:[=:]\s*|\s+)["']?)[A-Za-z0-9_-]{32,}=*''', re.I), r"\1[redacted]"),
)


def sensitive_tool(name: object) -> bool:
    return type(name) is str and _SENSITIVE_TOOL.search(name) is not None


def credential_path(path: object) -> bool:
    return type(path) is str and _CREDENTIAL_PATH.search(path) is not None


def touches_credential_file(args: object) -> bool:
    """True when a file tool's arguments name a credential file (so its content must not leave the process)."""
    if type(args) is not dict:
        return False
    if credential_path(args.get("path")):
        return True
    patch = args.get("patch")
    return type(patch) is str and any(credential_path(path) for path in _PATCH_PATHS.findall(patch[:200_000]))


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


def _decoded(value: object) -> object:
    # Hermes returns tool results as JSON text. Redacting the text form lets an assignment rule run past
    # the value into the JSON syntax; decoding first keeps each secret inside its own leaf.
    if type(value) is not str or len(value) > LEAF_CAP or value.lstrip()[:1] not in ("{", "["):
        return value
    try:
        return snapshot(json.loads(value))
    except (ValueError, RecursionError):
        return value


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
            # Numbers and booleans can't carry a secret (keeps fields such as max_tokens).
            return {text(key, 4096): _REDACTED if credential_key(key) and type(child) in (str, dict, list) else
                    walk(_decoded(child), 16384) if key == "result" else
                    walk(child, 16384 if key in _LONG_KEYS else limit)
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


def tail_source(output: object) -> tuple[str, int] | None:
    """The raw material for a terminal tail: (last LEAF_CAP + TAIL_MARGIN characters, full length)."""
    if type(output) is not str:
        return None
    return output[-(LEAF_CAP + TAIL_MARGIN):], len(output)


def redact_tail(raw: str, full_length: int, redact_fn: Callable[[str], str]) -> tuple[str, bool]:
    """Redact first (forced Hermes redaction, then the local patterns), then cut: (text <= LEAF_CAP, was_cut)."""
    try:
        safe = redact_fn(raw)
        if type(safe) is not str:
            return _REDACTED, True
    except Exception:
        safe = raw
    safe = local_redact(safe)
    cut = full_length > len(raw)
    if cut:
        # The margin absorbed any secret the raw cut sliced through; it never leaves the process.
        safe = safe[min(TAIL_MARGIN, len(safe)):]
    if len(safe) > LEAF_CAP:
        safe, cut = safe[-LEAF_CAP:], True
    return safe, cut


def redact_watch(watch: dict, redact_fn: Callable[[str], str]) -> dict:
    """Bounded, redacted terminal capture: {output, tail, exitCode, cwd}."""
    result: dict = {}
    raw = watch.get("raw_output")
    if type(raw) is str:
        result["output"], result["tail"] = redact_tail(raw, watch.get("full_length", len(raw)), redact_fn)
    code = watch.get("exit_code")
    if type(code) is int and type(code) is not bool:
        result["exitCode"] = code
    shot = watch.get("screenshot_path")
    if type(shot) is str and 0 < len(shot) <= 4096:
        result["screenshotPath"] = shot
    cwd = watch.get("cwd")
    if type(cwd) is str:
        try:
            cwd = redact_fn(cwd)
        except Exception:
            pass
        result["cwd"] = local_redact(cwd)[:4096] if type(cwd) is str else _REDACTED
    return result
