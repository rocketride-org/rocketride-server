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
"""

import json
import os
import sys
from typing import Optional, TypedDict


class ConnectionDiscoveryInfo(TypedDict):
    """Shape of the connection discovery file's contents."""

    uri: str
    apiKey: str
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


def _is_process_alive(pid: int) -> bool:
    """Best-effort liveness check. Never raises; unsupported platforms/errors
    are treated as "can't tell," which callers take as "assume alive" so a
    permissions error never hides an otherwise-usable hint.
    """
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


def read_connection_discovery(*, check_process_alive: bool = True) -> Optional[ConnectionDiscoveryInfo]:
    """Reads and validates the connection discovery file, or returns ``None``.

    Returns ``None`` (rather than raising) for: the file not existing, invalid
    JSON, a shape missing ``uri``/``pid``, or -- when `check_process_alive` is
    True (the default) -- a ``pid`` that's no longer running, e.g. a crashed
    engine that never got to clean up its own entry on exit.
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
    if not isinstance(uri, str) or not uri or not isinstance(pid, int):
        return None

    if check_process_alive and not _is_process_alive(pid):
        return None

    api_key = data.get('apiKey')
    updated_at = data.get('updatedAt')
    return ConnectionDiscoveryInfo(
        uri=uri,
        apiKey=api_key if isinstance(api_key, str) else '',
        pid=pid,
        updatedAt=updated_at if isinstance(updated_at, str) else '',
    )
