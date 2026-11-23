# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""Filesystem boundary for app compilers, separate from the bundler guard.

The compiler gets one writable job and the read-only platform toolchain.
Neither a tsconfig path nor an imported dependency can grant another read.
Hosted engines require the boundary; an unavailable provider fails the build.
"""

import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import List, Optional


class SandboxUnavailable(RuntimeError):
    """The required isolation provider cannot be configured safely."""


def required() -> bool:
    """Hosted builds cannot opt out; local OSS engines can opt in."""
    hosted = any(flag in sys.argv for flag in ('--saas', '--hosted', '--shared-host'))
    mode = os.environ.get('RR_APP_BUILD_SANDBOX', 'required' if hosted else 'off').strip().lower()
    if mode not in ('required', 'off'):
        raise SandboxUnavailable('RR_APP_BUILD_SANDBOX must be required or off')
    if hosted and mode != 'required':
        raise SandboxUnavailable('hosted app builds require RR_APP_BUILD_SANDBOX=required')
    return mode == 'required'


def _real_directory(path: str) -> str:
    real = os.path.realpath(path)
    if not os.path.isdir(real) or real == os.path.sep:
        raise SandboxUnavailable('app build sandbox requires an existing, non-root directory')
    return real


def _under(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


def command(argv: List[str], cwd: str, job_dir: str, toolchain_dir: str) -> List[str]:
    """Wrap one compiler invocation without exposing the host filesystem.

    Absolute paths are preserved, so the same canonical config and diagnostic
    paths work inside and outside the sandbox. No host HOME, store, service
    account token, engine installation or neighbouring job is mounted.
    """
    if not required():
        return list(argv)
    job = _real_directory(job_dir)
    toolchain = _real_directory(toolchain_dir)
    working = _real_directory(cwd)
    if not _under(working, job) or _under(toolchain, job) or _under(job, toolchain):
        raise SandboxUnavailable('app build job, cwd and toolchain roots are not isolated')
    if not argv or not os.path.isabs(argv[0]):
        raise SandboxUnavailable('sandboxed compilers require an absolute platform Node executable')
    node = os.path.realpath(argv[0])
    if not os.path.isfile(node):
        raise SandboxUnavailable('platform Node executable is missing')
    home = os.path.join(job, '.home')
    temporary = os.path.join(job, '.tmp')
    os.makedirs(home, exist_ok=True)
    os.makedirs(temporary, exist_ok=True)
    if sys.platform.startswith('linux'):
        provider = shutil.which('bwrap')
        if not provider:
            raise SandboxUnavailable('bubblewrap is required for hosted app builds')
        args = [
            provider,
            '--die-with-parent',
            '--new-session',
            '--unshare-user',
            '--unshare-pid',
            '--unshare-net',
            '--unshare-ipc',
            '--unshare-uts',
            '--cap-drop',
            'ALL',
            '--proc',
            '/proc',
            '--dev',
            '/dev',
            '--tmpfs',
            '/tmp',
        ]
        # Only the dynamic linker/runtime libraries, not /usr or /etc as a
        # whole. In particular /opt/rocketride and /var/run/secrets stay absent.
        readonly = [p for p in ('/lib', '/lib64', '/usr/lib', '/usr/lib64', '/etc/ld.so.cache') if os.path.exists(p)]
        readonly += [node, toolchain]
        parents = set()
        for target in readonly + [job]:
            parents.update(str(p) for p in Path(target).parents if str(p) != '/')
        for parent in sorted(parents, key=lambda p: (p.count('/'), p)):
            if parent not in ('/tmp', '/dev', '/proc'):
                args += ['--dir', parent]
        for root in readonly:
            args += ['--ro-bind', root, root]
        args += ['--bind', job, job, '--chdir', working, '--setenv', 'HOME', home, '--setenv', 'TMPDIR', temporary]
        return [*args, '--', node, *argv[1:]]
    if sys.platform == 'darwin':
        provider = '/usr/bin/sandbox-exec'
        if not os.path.isfile(provider):
            raise SandboxUnavailable('sandbox-exec is unavailable for this local app build')
        # JSON string escaping is also valid for Seatbelt string literals;
        # caller-controlled paths cannot inject another policy expression.
        literal = json.dumps
        profile = '\n'.join(
            [
                '(version 1)',
                '(deny default)',
                '(allow process*)',
                '(allow sysctl-read)',
                '(allow mach-lookup)',
                '(allow file-read-metadata)',
                '(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple/System")',
                f'  (literal {literal(node)}) (literal "/usr/bin/env") (literal "/dev/null")',
                '  (literal "/") (literal "/dev/random") (literal "/dev/urandom")',
                f'  (subpath {literal(job)}) (subpath {literal(toolchain)}))',
                f'(allow file-write* (subpath {literal(job)}) (literal "/dev/null"))',
            ]
        )
        return [provider, '-p', profile, '/usr/bin/env', f'HOME={home}', f'TMPDIR={temporary}', node, *argv[1:]]
    raise SandboxUnavailable('no filesystem sandbox provider is available on this platform')


# sandbox-exec prints its own startup failures as `sandbox-exec: <message>`. It has no
# status channel, so a message counts only when the output is nothing but such lines and
# none of them is shaped like a compiler diagnostic (an app file may be named to look like one).
_SEATBELT_ERROR = re.compile(r'^sandbox-exec: (?P<message>.+)$')
_DIAGNOSTIC = re.compile(r'\(\d+,\d+\): (?:error|warning) |: error TS\d+')


def startup_failure(argv: List[str], code: int, output: str, started: Optional[bool] = None) -> Optional[str]:
    """The provider's own message when the sandbox failed to start, else None.

    A kernel that denies user namespaces (or a Seatbelt refusal) makes the
    provider exit non-zero before the compiler runs. That is the platform's
    fault, not the app's: callers raise an infrastructure failure, never a
    compile error the developer is asked to fix.

    bwrap is decided by its own status channel, never by its text, because the
    compiler's output is app-controlled: ``started`` says whether bwrap wrote
    its child pid (``--info-fd``), which it does only once the sandbox is set up.

    Args:
        argv: The command line that ran (the sandboxed one, or the bare one).
        code: Its exit code.
        output: Its merged stdout and stderr.
        started: For bwrap, whether it reported a child pid; None when unknown.
    """
    if code == 0 or not argv:
        return None
    provider = os.path.basename(argv[0])
    if provider == 'bwrap':
        if started is not False:
            return None
        first = next((line.strip() for line in output.splitlines() if line.strip()), '')
        first = first[len('bwrap: ') :] if first.startswith('bwrap: ') else first
        return (first or f'bwrap exited with status {code} before the sandbox started')[:500]
    if provider == 'sandbox-exec':
        lines = [line for line in output.splitlines() if line.strip()]
        found = [_SEATBELT_ERROR.match(line) for line in lines]
        if not found or not all(found) or any(_DIAGNOSTIC.search(line) for line in lines):
            return None
        return found[0].group('message').strip()[:500]
    return None
