"""Moves a file to a new name in ONE kernel call that never replaces anything (audit 3, S3-001).

usage: rename-noreplace.py --probe
       rename-noreplace.py SOURCE DEST
       rename-noreplace.py --serve

--serve answers many moves over one process (a bulk unzip would otherwise start a Python per file): one JSON line
{"from": ..., "to": ...} per request on stdin, one {"code": N} line per answer on stdout, in order; it ends at EOF.

Linux renameat2(2) with RENAME_NOREPLACE: the destination is created atomically or the call fails with EEXIST and
nothing at all changes. Nothing is ever unlinked, so a file somebody else puts at either name meanwhile cannot be lost.
Exit status: 0 moved, 17 destination exists, 2 source (or a folder) missing, 22 or 95 not supported here (kernel or
filesystem), 5 anything else (including bad usage). Standard library only; run with `python3 -I`.
"""
import ctypes
import os
import sys

AT_FDCWD = -100
RENAME_NOREPLACE = 1
OTHER = 5


def renameat2():
    libc = ctypes.CDLL(None, use_errno=True)
    fn = libc.renameat2  # AttributeError on a libc without it
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    return fn


def call(fn, source, dest):
    ctypes.set_errno(0)
    if fn(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(dest), RENAME_NOREPLACE) == 0:
        return 0
    return ctypes.get_errno() or OTHER


def serve(fn):
    import json

    for line in sys.stdin:
        try:
            request = json.loads(line)
            code = call(fn, request["from"], request["to"])
            code = code if code in (0, 2, 17, 22, 95) else (95 if code in (38, 1) else OTHER)
        except Exception:
            code = OTHER
        sys.stdout.write(json.dumps({"code": code}) + "\n")
        sys.stdout.flush()
    return 0


def main(argv):
    try:
        fn = renameat2()
    except (AttributeError, OSError):
        return 95
    if len(argv) == 2 and argv[1] == "--probe":
        # A missing source answers ENOENT only when the syscall exists.
        return 0 if call(fn, "/nonexistent-score-probe-a", "/nonexistent-score-probe-b") == 2 else 95
    if len(argv) == 2 and argv[1] == "--serve":
        return serve(fn)
    if len(argv) != 3:
        return OTHER
    code = call(fn, argv[1], argv[2])
    return code if code in (0, 2, 17, 22, 95) else (95 if code in (38, 1) else OTHER)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
