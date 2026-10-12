"""Signal processes only when they are provably the recorded ones (7.7a review finding 10).

usage: pidfd-signal.py --probe
       pidfd-signal.py SIGNUM PID:STARTTIME [PID:STARTTIME ...]
       pidfd-signal.py --group SIGNUM LEADERPID:STARTTIME

Opens a pidfd first (the fd pins that exact process: its pid can't be reused while it is open), then reads the start
time from /proc/<pid>/stat and signals through the fd only on a match. One line per target on stdout: "<pid> <code>".
With --group the signal goes to the leader's whole process group through the leader's pidfd
(PIDFD_SIGNAL_PROCESS_GROUP, Linux 6.9+), so the group number is never used and can't have been reused.
Codes: 0 signalled, 3 identity mismatch or already gone, 4 pidfds (or the group flag) unsupported, 5 other error.
Exit status: 0 when every target was signalled, else the first non-zero code (4, then 5, then 3); 5 on bad usage.
Standard library only; run with `python3 -I`.
"""
import os
import signal
import sys

ENOSYS = 38
EINVAL = 22
PIDFD_SIGNAL_PROCESS_GROUP = 4


def start_time(pid):
    with open("/proc/%d/stat" % pid, "r") as handle:
        data = handle.read()
    # The command name is in parentheses and may itself contain spaces or parentheses.
    return data[data.rindex(")") + 2:].split()[19]


def signal_one(pid, expected, signum, group=False):
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return 3
    except AttributeError:
        return 4
    except OSError as error:
        return 4 if error.errno == ENOSYS else 5
    try:
        try:
            actual = start_time(pid)
        except (FileNotFoundError, ProcessLookupError):
            return 3
        if actual != expected:
            return 3
        if group:
            signal.pidfd_send_signal(fd, signum, None, PIDFD_SIGNAL_PROCESS_GROUP)
        else:
            signal.pidfd_send_signal(fd, signum)
        return 0
    except ProcessLookupError:
        return 3
    except AttributeError:
        return 4
    except OSError as error:
        # EINVAL: this kernel doesn't know the group flag.
        return 4 if group and error.errno == EINVAL else 5
    except Exception:
        return 5
    finally:
        os.close(fd)


def main(argv):
    if len(argv) == 2 and argv[1] == "--probe":
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            return 4
        try:
            os.close(os.pidfd_open(os.getpid()))
        except OSError:
            return 4
        return 0
    group = len(argv) > 1 and argv[1] == "--group"
    if group:
        argv = [argv[0]] + argv[2:]
    if len(argv) < 3 or (group and len(argv) != 3):
        return 5
    try:
        signum = int(argv[1])
        targets = []
        for item in argv[2:]:
            pid, start = item.split(":", 1)
            targets.append((int(pid), start))
    except ValueError:
        return 5
    codes = []
    for pid, start in targets:
        code = signal_one(pid, start, signum, group)
        codes.append(code)
        print("%d %d" % (pid, code))
    for wanted in (4, 5, 3):
        if wanted in codes:
            return wanted
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
