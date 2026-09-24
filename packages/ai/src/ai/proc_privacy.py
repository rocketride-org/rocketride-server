# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Keep other processes of the same OS user out of this process's /proc entries.

On Linux, ``/proc/<pid>/environ``, ``/proc/<pid>/mem`` and friends are readable
by any process running as the same UID while the target is *dumpable*, which is
the default. On a hosted engine the engine and every task run as one UID, so a
task could read the engine's environment (deployment credentials) or another
tenant's task. ``prctl(PR_SET_DUMPABLE, 0)`` makes those entries root-only.

Crash reporting keeps working: Crashpad's signal handler sets the process
dumpable again for the duration of a crash dump (``ScopedPrSetDumpable``).

The flag resets on ``execve``, so every process that should be private calls
:func:`make_process_private` itself, and is readable until it does (native
and interpreter startup, then the ``ai`` package import). It covers only the
calling process: anything that process starts is a separate process.
"""

import ctypes
import os
import sys

# <linux/prctl.h>
PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4

# Operator-tier opt-in for engines that are not hosted (self-hosted, tests).
# RR_* is not writable by pipeline callers, and the task env allowlist passes
# this one name so the setting reaches task processes.
CONST_PROC_PRIVATE_ENV = 'RR_PROC_PRIVATE'


def should_make_private() -> bool:
    """True when this process should hide its /proc entries. Always False off Linux.

    Hosted engines start with ``--saas`` (the server) or ``--hosted`` (its
    tasks); neither can be removed by a pipeline. ``RR_PROC_PRIVATE=1`` opts
    any other engine in. It is read from the process environment at call
    time; the engine calls after loading its ``.env``.
    """
    if not sys.platform.startswith('linux'):
        return False
    if '--saas' in sys.argv or '--hosted' in sys.argv:
        return True
    return os.environ.get(CONST_PROC_PRIVATE_ENV, '').strip() == '1'


def _prctl(option: int, arg2: int = 0) -> int:
    """Call prctl(2) and return its result. Arguments go as unsigned long, which is what the kernel reads."""
    fn = ctypes.CDLL(None, use_errno=True).prctl
    fn.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    fn.restype = ctypes.c_int
    return fn(option, arg2, 0, 0, 0)


def make_process_private() -> None:
    """Clear this process's dumpable flag (Linux).

    Raises OSError when the call fails or the process is still dumpable
    afterwards, so the caller decides whether to continue.
    """
    if _prctl(PR_SET_DUMPABLE, 0) != 0:
        err = ctypes.get_errno()
        raise OSError(err, f'prctl(PR_SET_DUMPABLE, 0) failed: {os.strerror(err)}')
    if is_dumpable():
        raise OSError('prctl(PR_SET_DUMPABLE, 0) did not take effect')


def is_dumpable() -> bool:
    """Current dumpable state (Linux).

    Raises OSError when the query itself fails, so a failed check is never
    mistaken for a private process.
    """
    rc = _prctl(PR_GET_DUMPABLE)
    if rc < 0:
        err = ctypes.get_errno()
        raise OSError(err, f'prctl(PR_GET_DUMPABLE) failed: {os.strerror(err)}')
    return rc > 0
