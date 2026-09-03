# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
GitHub tool node - global (shared) state.

Reads auth config (PAT or GitHub App), default_repo, and read_only flag from
config. For App auth, mints and caches short-lived installation tokens,
auto-refreshing them shortly before they expire.
"""

from __future__ import annotations

import base64
import threading
import time

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from . import github_client

# Refresh an installation token this many seconds before its actual expiry, so
# an in-flight request never races a token that dies mid-call.
REFRESH_SKEW_SECONDS = 60


def _decode_pem_blob(value: str) -> str:
    """Decode a services.json ``data-url`` field's value into raw PEM text.

    Mirrors ``tool_google_workspace/google_client.py``'s ``_decode_blob``: strips a
    ``data:...;base64,`` prefix and base64-decodes, or passes through raw text
    (e.g. a value pasted directly rather than uploaded as a file).
    """
    value = (value or '').strip()
    if not value:
        return ''
    if value.startswith('data:') and ';base64,' in value:
        value = value.split(';base64,', 1)[1]
        return base64.b64decode(value).decode('utf-8')
    return value


class IGlobal(IGlobalBase):
    """Global state for tool_github."""

    auth_type: str = 'pat'
    token: str = ''
    app_id: str = ''
    private_key_pem: str = ''
    installation_id: str = ''
    default_repo: str = ''
    read_only: bool = False

    _cached_token: str = ''
    _cached_expiry: float = 0.0
    _lock: threading.Lock

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.auth_type = str((cfg.get('authType') or 'pat')).strip()
        self.default_repo = str((cfg.get('defaultRepo') or '')).strip()
        self.read_only = bool(cfg.get('readOnly', False))
        self._cached_token = ''
        self._cached_expiry = 0.0
        self._lock = threading.Lock()

        if self.auth_type == 'app':
            self.app_id = str((cfg.get('appId') or '')).strip()
            self.private_key_pem = _decode_pem_blob(cfg.get('privateKey'))
            self.installation_id = str((cfg.get('installationId') or '')).strip()
            missing = [
                name
                for name, value in (
                    ('App ID', self.app_id),
                    ('private key', self.private_key_pem),
                    ('installation ID', self.installation_id),
                )
                if not value
            ]
            if missing:
                raise Exception(f'tool_github: {", ".join(missing)} required for GitHub App auth')
            # Fail fast: parse the PEM now so a malformed key surfaces at
            # pipeline open, not on the first tool call.
            github_client.load_app_private_key(self.private_key_pem)
        else:
            self.token = str((cfg.get('token') or '')).strip()
            if not self.token:
                raise Exception('tool_github: token is required')

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            auth_type = str((cfg.get('authType') or 'pat')).strip()
            if auth_type == 'app':
                missing = [
                    name
                    for name, key in (
                        ('App ID', 'appId'),
                        ('private key', 'privateKey'),
                        ('installation ID', 'installationId'),
                    )
                    if not str((cfg.get(key) or '')).strip()
                ]
                if missing:
                    warning(f'{", ".join(missing)} required for GitHub App auth')
                else:
                    try:
                        github_client.load_app_private_key(_decode_pem_blob(cfg.get('privateKey')))
                    except ValueError as e:
                        warning(str(e))
            elif not str((cfg.get('token') or '')).strip():
                warning('token is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.auth_type = 'pat'
        self.token = ''
        self.app_id = ''
        self.private_key_pem = ''
        self.installation_id = ''
        self.default_repo = ''
        self.read_only = False
        self._cached_token = ''
        self._cached_expiry = 0.0

    def get_token(self) -> str:
        """Return a currently-valid token, minting/refreshing an installation
        token if needed. Plain passthrough for PAT auth.
        """
        if self.auth_type != 'app':
            return self.token
        with self._lock:
            now = time.time()
            if not self._cached_token or now >= self._cached_expiry - REFRESH_SKEW_SECONDS:
                self._cached_token, self._cached_expiry = github_client.mint_installation_token(
                    self.app_id, self.private_key_pem, self.installation_id
                )
            return self._cached_token
