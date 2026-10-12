"""Starts a fallback coding CLI so that it dies with Score, and not before Score has recorded it (7.7a v4 review #5).

usage: pdeathsig-exec.py --probe
       pdeathsig-exec.py PARENTPID GATEFD -- COMMAND [ARG ...]

Sets prctl(PR_SET_PDEATHSIG, SIGKILL), so the kernel kills this process when its parent (Score) dies, and checks the
parent is still PARENTPID (it may have died before the prctl took effect). Then it waits for the single byte "g" on
GATEFD, which Score writes only after the process is recorded durably; EOF or anything else (Score died, or the record
failed) ends it without running the command. Finally it closes GATEFD and execs the command. PDEATHSIG survives
execve, so the CLI is killed when Score dies; descendants the CLI starts are NOT covered (they are not our children).
The signal follows the parent *thread* that spawned us, which is Node's main thread for child_process.
Exit codes: 0 never (exec replaces us), 3 parent gone or gate not opened, 4 prctl unsupported, 5 bad usage,
127 command could not be executed. Standard library only; run with `python3 -I`.
"""
import ctypes
import os
import signal
import sys

PR_SET_PDEATHSIG = 1


def set_pdeathsig():
    libc = ctypes.CDLL(None, use_errno=True)
    return libc.prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0) == 0


def main(argv):
    if len(argv) == 2 and argv[1] == "--probe":
        if not sys.platform.startswith("linux") or not set_pdeathsig():
            return 4
        sys.stdout.write(sys.executable + "\n")
        return 0
    if len(argv) < 5 or argv[3] != "--" or not argv[1].isdigit() or not argv[2].isdigit():
        sys.stderr.write("pdeathsig-exec: bad usage\n")
        return 5
    parent = int(argv[1])
    gate = int(argv[2])
    command = argv[4:]
    try:
        if not set_pdeathsig():
            return 4
    except Exception:
        return 4
    if os.getppid() != parent:
        return 3
    try:
        opened = os.read(gate, 1) == b"g"
    except OSError:
        opened = False
    if not opened or os.getppid() != parent:
        return 3
    os.close(gate)
    try:
        os.execvp(command[0], command)
    except OSError as error:
        sys.stderr.write("pdeathsig-exec: cannot run %s: %s\n" % (command[0], error.strerror))
        return 127


if __name__ == "__main__":
    sys.exit(main(sys.argv))
