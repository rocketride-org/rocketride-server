"""ai.proc_privacy — hiding a process's /proc entries from its own UID.

The dumpable flag is per process and cannot be observed from a sibling
without reading /proc, so the real-kernel checks run in a child interpreter:
the pytest process itself stays dumpable.
"""

import os
import subprocess
import sys
import textwrap

import pytest

import ai.proc_privacy as pp

linux_only = pytest.mark.skipif(not sys.platform.startswith('linux'), reason='prctl is Linux-only')

_SRC = os.path.dirname(os.path.dirname(os.path.abspath(pp.__file__)))


def _can_bypass_dumpable() -> bool:
    """True when this runner is root or holds CAP_SYS_PTRACE, which ignore the dumpable flag."""
    if os.geteuid() == 0:
        return True
    with open('/proc/self/status') as f:
        cap_eff = next(line.split()[1] for line in f if line.startswith('CapEff:'))
    return bool(int(cap_eff, 16) & (1 << 19))  # CAP_SYS_PTRACE


# sys.path, not PYTHONPATH: the engine binary does not read PYTHONPATH.
_IMPORT_SRC = f'import sys; sys.path.insert(0, {_SRC!r})\n'


def _child(code: str) -> subprocess.CompletedProcess:
    """Run ``code`` in a fresh interpreter that imports this checkout's ai package."""
    return subprocess.run(
        [sys.executable, '-c', _IMPORT_SRC + textwrap.dedent(code)], capture_output=True, text=True, timeout=60
    )


@linux_only
def test_make_process_private_clears_dumpable_in_a_real_process():
    out = _child(
        """
        from ai.proc_privacy import is_dumpable, make_process_private
        before = is_dumpable()
        make_process_private()
        print(before, is_dumpable())
        """
    )
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ['True', 'False']


@linux_only
@pytest.mark.skipif(
    sys.platform.startswith('linux') and _can_bypass_dumpable(), reason='root/CAP_SYS_PTRACE ignores dumpable'
)
def test_private_process_environ_is_unreadable_by_the_same_uid():
    """The property that matters: a same-UID sibling can no longer read environ."""
    child = subprocess.Popen(
        [
            sys.executable,
            '-c',
            _IMPORT_SRC + 'import time\n'
            'from ai.proc_privacy import make_process_private\n'
            'make_process_private()\n'
            'print("ready", flush=True)\n'
            'time.sleep(30)\n',
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout.readline().strip() == 'ready'
        with pytest.raises(PermissionError):
            with open(f'/proc/{child.pid}/environ', 'rb') as f:
                f.read()
    finally:
        child.kill()
        child.wait()


@linux_only
def test_dumpable_process_environ_is_readable_control():
    """Control for the test above: without the call the canary is readable."""
    child = subprocess.Popen(
        [sys.executable, '-c', 'import time\nprint("ready", flush=True)\ntime.sleep(30)\n'],
        stdout=subprocess.PIPE,
        text=True,
        env=dict(os.environ, PROC_PRIVACY_CANARY='canary-value-123'),
    )
    try:
        assert child.stdout.readline().strip() == 'ready'
        with open(f'/proc/{child.pid}/environ', 'rb') as f:
            assert b'PROC_PRIVACY_CANARY=canary-value-123' in f.read()
    finally:
        child.kill()
        child.wait()


def test_never_private_off_linux(monkeypatch):
    """No prctl on macOS/Windows: even a hosted flag must not lead to calling it."""
    monkeypatch.setattr(pp.sys, 'platform', 'darwin')
    monkeypatch.setattr(pp.sys, 'argv', ['node.py', '--hosted'])
    assert pp.should_make_private() is False


@pytest.mark.parametrize(
    'argv, env, expected',
    [
        (['node.py'], None, False),
        (['node.py', '--hosted'], None, True),
        (['eaas.py', '--saas'], None, True),
        (['node.py'], '1', True),
        (['node.py'], ' 1 ', True),
        (['node.py'], '0', False),
        (['node.py'], 'true', False),  # only the documented value opts in
    ],
)
def test_should_make_private(monkeypatch, argv, env, expected):
    monkeypatch.setattr(pp.sys, 'platform', 'linux')
    monkeypatch.setattr(pp.sys, 'argv', argv)
    if env is None:
        monkeypatch.delenv(pp.CONST_PROC_PRIVATE_ENV, raising=False)
    else:
        monkeypatch.setenv(pp.CONST_PROC_PRIVATE_ENV, env)
    assert pp.should_make_private() is expected


def test_set_failure_raises_oserror(monkeypatch):
    monkeypatch.setattr(pp, '_prctl', lambda option, arg2=0: -1)
    with pytest.raises(OSError, match='PR_SET_DUMPABLE'):
        pp.make_process_private()


def test_still_dumpable_after_the_call_raises(monkeypatch):
    monkeypatch.setattr(pp, '_prctl', lambda option, arg2=0: 0 if option == pp.PR_SET_DUMPABLE else 1)
    with pytest.raises(OSError, match='did not take effect'):
        pp.make_process_private()


def test_failed_verification_is_not_reported_as_private(monkeypatch):
    """SET succeeds but the GET that verifies it fails: that must raise, not pass as private."""
    monkeypatch.setattr(pp, '_prctl', lambda option, arg2=0: 0 if option == pp.PR_SET_DUMPABLE else -1)
    with pytest.raises(OSError, match='PR_GET_DUMPABLE'):
        pp.make_process_private()
