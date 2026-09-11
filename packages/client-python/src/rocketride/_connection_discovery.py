# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Local engine connection discovery — reads the file the VS Code extension's
local engine backend writes on startup.

``--port=0`` gives the local engine a fresh OS-assigned port every restart.
Previously the only way to find it without the VS Code extension's own
connect flow was reading process listings by hand (e.g. ``lsof``). The
extension (``apps/vscode/src/engine/local/engine-local.ts``, mirroring
``connectionDiscovery.ts`` here) now writes the resolved URI to a small,
fixed, workspace-independent JSON file under the engine's own install
directory whenever it starts, and removes it when that same process exits.

This module is the read side: a pure, best-effort lookup used as a fallback
in :class:`RocketRideClient` when no explicit ``uri`` was given and
``ROCKETRIDE_URI`` isn't set via the environment or a workspace ``.env``.
Never raises -- a missing, malformed, or stale file just means "no hint
available," not an error.

Canonical schema, kept in sync by hand across this file and the write side
(``apps/vscode/src/engine/local/connectionDiscovery.ts``; there is no
TypeScript reader yet) -- see :class:`ConnectionDiscoveryInfo` for the fields
and ``read_connection_discovery`` for exactly what gets validated before a
parsed file is trusted. There used to be a third field, ``apiKey``, hardcoded
to the local-mode default; it was removed (see #1851 review) because a
credential-shaped field that is never actually a credential invites the next
reader to trust it as one.

Security note: discovery only ever means "a local engine on this machine."
A discovery file naming a non-loopback host is never trusted -- see
``is_loopback_host`` -- because adopting an arbitrary discovered URI would
hand it whatever real credential the caller supplies via ``auth``/
``ROCKETRIDE_APIKEY``, redirecting it to that host.
"""

import ipaddress
import json
import os
import sys
import urllib.parse
from typing import Optional, TypedDict


class ConnectionDiscoveryInfo(TypedDict):
    """Shape of the connection discovery file's contents."""

    uri: str
    pid: int
    updatedAt: str


def get_user_config_dir() -> str:
    """Per-user RocketRide config directory, matching the VS Code extension's
    ``getUserConfigDir()`` (``apps/vscode/src/engine/config/config-migration.ts``)
    exactly so both sides agree on where to look without any coordination:

    - Windows: ``%LOCALAPPDATA%\\RocketRide``
    - macOS:   ``~/Library/Application Support/RocketRide``
    - Linux:   ``~/.config/RocketRide``
    """
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local')
        return os.path.join(base, 'RocketRide')
    if sys.platform == 'darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'RocketRide')
    return os.path.join(os.path.expanduser('~'), '.config', 'RocketRide')


def connection_discovery_path() -> str:
    """Path to the local engine's connection discovery file."""
    return os.path.join(get_user_config_dir(), 'engine', 'connection.json')


def _is_absolute_http_uri(uri: str) -> bool:
    """True for an absolute ``http(s)://`` URI -- the only shape the writer
    ever produces (a bare ``host:port`` or a ``ws(s)://`` URI is not a
    mistake it makes, so reject it rather than guess at normalizing it).
    """
    try:
        parsed = urllib.parse.urlparse(uri)
    except ValueError:
        return False
    return parsed.scheme in ('http', 'https') and bool(parsed.hostname)


def is_loopback_host(hostname: str) -> bool:
    """True when ``hostname`` is ``localhost`` or a loopback IP address.

    Public (not module-private) because it's also used outside discovery: see
    ``TransportWebSocket.connect()``, which bypasses any configured proxy for
    a loopback target -- an env-configured proxy would otherwise still see
    (and could intercept) a ``ws://localhost:PORT`` connection and the real
    credential sent over it, discovery-selected or not.

    ``ipaddress.ip_address`` only accepts strict, unambiguous dotted-decimal
    IPv4 (or standard IPv6) -- it rejects the octal/decimal/shortened
    alternate spellings (e.g. ``0177.0.0.1``, ``2130706433``, ``127.1``) that
    could otherwise be used to smuggle a non-loopback-looking string past a
    naive string comparison. Anything that doesn't parse this strictly, or
    that parses but isn't in the loopback range, is rejected -- deny by
    default rather than try to enumerate every possible spelling.
    """
    if hostname.lower() == 'localhost':
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def is_loopback_discovery_uri(uri: str) -> bool:
    """True when ``uri``'s host is loopback.

    Discovery only ever means "a local engine on this machine" -- the writer
    never emits anything else. This MUST be checked before adopting a
    discovered URI or any credential alongside it: without it, a discovery
    file naming an attacker-controlled host would redirect a client's real
    API key there. See the module docstring's security note.
    """
    try:
        hostname = urllib.parse.urlparse(uri).hostname
    except ValueError:
        return False
    return bool(hostname) and is_loopback_host(hostname)


def _is_process_alive(pid: int) -> bool:
    """Best-effort liveness check. Never raises; unsupported platforms/errors
    are treated as "can't tell," which callers take as "assume alive" so a
    permissions error never hides an otherwise-usable hint.
    """
    if sys.platform == 'win32':
        return _is_process_alive_windows(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # E.g. PermissionError on some platforms for a live process owned by
        # another user -- can't confirm dead, so don't discard the hint.
        return True
    except Exception:
        return True


def _is_process_alive_windows(pid: int) -> bool:
    """Windows liveness check that never sends a signal.

    ``os.kill(pid, 0)`` is a POSIX idiom; on Windows, ``os.kill()`` maps a
    signal number to a real Win32 action (``GenerateConsoleCtrlEvent`` for
    the CTRL_* values, of which 0 is one, or ``TerminateProcess`` otherwise)
    rather than a no-op existence probe, so it cannot reliably distinguish
    "alive" from "dead" here -- and in the worst case can affect a real,
    unrelated process. Query the process's exit code via the Win32 API
    directly instead, exactly like ``psutil``/similar libraries do.
    """
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    ERROR_INVALID_PARAMETER = 87

    # `use_last_error=True` so `ctypes.get_last_error()` below reflects this
    # call's `GetLastError()` (`ctypes.windll` doesn't track it).
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)  # type: ignore[attr-defined]
    # `HANDLE` is pointer-sized (64 bits on 64-bit Windows); ctypes defaults an
    # unset restype to `c_int` (32 bits), which would truncate the handle
    # OpenProcess returns before GetExitCodeProcess/CloseHandle use it. Declare
    # every signature explicitly rather than rely on the default.
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.CloseHandle.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # ERROR_INVALID_PARAMETER means no such process; anything else (e.g.
        # access denied) -- can't confirm dead, assume alive.
        return ctypes.get_last_error() != ERROR_INVALID_PARAMETER
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return True
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def read_connection_discovery(*, check_process_alive: bool = True) -> Optional[ConnectionDiscoveryInfo]:
    """Reads and validates the connection discovery file, or returns ``None``.

    Returns ``None`` (rather than raising) for: the file not existing, invalid
    JSON, a shape missing/malformed ``uri``/``pid``, a ``uri`` that isn't an
    absolute ``http(s)://`` loopback address (see ``is_loopback_discovery_uri``
    -- this is a security boundary, not just shape validation), or -- when
    `check_process_alive` is True (the default) -- a ``pid`` that's no longer
    running, e.g. a crashed engine that never got to clean up its own entry
    on exit.
    """
    try:
        with open(connection_discovery_path(), 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None

    if not isinstance(data, dict):
        return None
    uri = data.get('uri')
    pid = data.get('pid')
    if not isinstance(uri, str) or not _is_absolute_http_uri(uri):
        return None
    # `bool` is a subclass of `int` in Python, so explicitly exclude it --
    # otherwise a `pid: true` in the file would pass `isinstance(pid, int)`.
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    if not is_loopback_discovery_uri(uri):
        return None

    if check_process_alive and not _is_process_alive(pid):
        return None

    updated_at = data.get('updatedAt')
    return ConnectionDiscoveryInfo(
        uri=uri,
        pid=pid,
        updatedAt=updated_at if isinstance(updated_at, str) else '',
    )
