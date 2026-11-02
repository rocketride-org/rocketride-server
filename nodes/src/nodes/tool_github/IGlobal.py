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

import re
import threading
import time

from ai.common.config import Config
from ai.common.utils import decode_data_url
from rocketlib import IGlobalBase, OPEN_MODE, warning

from . import github_client

# Refresh an installation token this many seconds before its actual expiry, so
# an in-flight request never races a token that dies mid-call.
REFRESH_SKEW_SECONDS = 60
# After a failed early refresh, wait this long before asking GitHub again, so parallel
# tool calls do not queue behind a hanging token request while the cached token is valid.
REFRESH_RETRY_SECONDS = 15

AUTH_TYPES = ('pat', 'app')
_INSTALLATION_ID_RE = re.compile(r'[0-9]+')


def _decode_pem_blob(value: str) -> str:
    """Decode a ``data-url`` upload (or pasted raw PEM text) into PEM text."""
    value = (value or '').strip()
    if not value:
        return ''
    try:
        raw, _mime = decode_data_url(value)
        return raw.decode('utf-8')
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'tool_github: invalid GitHub App private key upload: {exc}') from exc


def _read_auth(cfg) -> dict:
    """Parse and validate the auth fields of a node config.

    Returns ``{'authType': 'pat', 'token': ...}`` or ``{'authType': 'app', 'appId': ...,
    'privateKeyPem': ..., 'installationId': ...}``. Raises ``ValueError`` with a
    user-facing message on any missing or malformed field; ``beginGlobal`` and
    ``validateConfig`` share it so they can never disagree.
    """
    auth_type = str(cfg.get('authType') or 'pat').strip()
    if auth_type not in AUTH_TYPES:
        raise ValueError(f'tool_github: unknown authType {auth_type!r}; expected "pat" or "app"')

    if auth_type == 'pat':
        token = str(cfg.get('token') or '').strip()
        if not token:
            raise ValueError('tool_github: token is required')
        return {'authType': 'pat', 'token': token}

    app_id = str(cfg.get('appId') or '').strip()
    private_key_pem = _decode_pem_blob(cfg.get('privateKey'))
    installation_id = str(cfg.get('installationId') or '').strip()
    missing = [
        name
        for name, value in (
            ('App ID', app_id),
            ('private key', private_key_pem),
            ('installation ID', installation_id),
        )
        if not value
    ]
    if missing:
        raise ValueError(f'tool_github: {", ".join(missing)} required for GitHub App auth')
    # The installation ID is a path segment of the token URL; only ASCII digits may reach it.
    if not _INSTALLATION_ID_RE.fullmatch(installation_id):
        raise ValueError('tool_github: installation ID must be numeric for GitHub App auth')
    # Parse the PEM now so a malformed key surfaces at pipeline open, not on the first tool call.
    github_client.load_app_private_key(private_key_pem)
    return {
        'authType': 'app',
        'appId': app_id,
        'privateKeyPem': private_key_pem,
        'installationId': installation_id,
    }


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
    _refresh_failed_at: float = 0.0
    _lock: threading.Lock

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.default_repo = str((cfg.get('defaultRepo') or '')).strip()
        self.read_only = bool(cfg.get('readOnly', False))
        self._cached_token = ''
        self._cached_expiry = 0.0
        self._refresh_failed_at = 0.0
        self._lock = threading.Lock()

        auth = _read_auth(cfg)
        self.auth_type = auth['authType']
        if self.auth_type == 'app':
            self.app_id = auth['appId']
            self.private_key_pem = auth['privateKeyPem']
            self.installation_id = auth['installationId']
        else:
            self.token = auth['token']

    def validateConfig(self) -> None:
        try:
            _read_auth(Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig))
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
        self._refresh_failed_at = 0.0

    def get_token(self) -> str:
        """Return a currently-valid token, minting/refreshing an installation
        token if needed. Plain passthrough for PAT auth.
        """
        if self.auth_type != 'app':
            return self.token
        with self._lock:
            now = time.time()
            still_valid = bool(self._cached_token) and now < self._cached_expiry
            needs_refresh = not still_valid or now >= self._cached_expiry - REFRESH_SKEW_SECONDS
            backing_off = still_valid and now < self._refresh_failed_at + REFRESH_RETRY_SECONDS
            if needs_refresh and not backing_off:
                try:
                    self._cached_token, self._cached_expiry = github_client.mint_installation_token(
                        self.app_id, self.private_key_pem, self.installation_id
                    )
                except Exception:
                    # Re-read the clock: the request may have hung for DEFAULT_TIMEOUT.
                    # A failed early refresh must not discard a token GitHub still accepts.
                    failed_at = time.time()
                    if not self._cached_token or failed_at >= self._cached_expiry:
                        raise
                    self._refresh_failed_at = failed_at
                    warning('tool_github: token refresh failed; using the cached token until it expires')
            return self._cached_token
