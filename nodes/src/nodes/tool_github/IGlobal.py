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

Reads the resolved node config: the selected auth branch (PAT or GitHub App),
default_repo, the read_only flag, the tool allowlist, the GraphQL response cap
and the rate-limit retry policy. The schema validates the scalars (types,
ranges, the allowlist's names); this module keeps the semantic checks the
schema cannot express: the PEM upload decodes to an RSA key and the
installation id is numeric. For App auth, mints and caches short-lived
installation tokens, auto-refreshing them shortly before they expire.
"""

from __future__ import annotations

import re
import threading
import time

from ai.common.utils import decode_data_url
from rocketlib import IGlobalBase, warning

from . import github_client
from .IInstance import validate_tool_names

# Refresh an installation token this many seconds before its actual expiry, so
# an in-flight request never races a token that dies mid-call.
REFRESH_SKEW_SECONDS = 60
# After a failed early refresh, wait this long before asking GitHub again, so parallel
# tool calls do not queue behind a hanging token request while the cached token is valid.
REFRESH_RETRY_SECONDS = 15

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
    """Read the active auth branch of the resolved config.

    Returns ``{'authType': 'pat', 'token': ...}`` or ``{'authType': 'app', 'appId': ...,
    'privateKeyPem': ..., 'installationId': ...}``. The schema requires the
    branch's text fields; this adds the checks it cannot express and raises
    ``ValueError`` with a user-facing message on any missing or malformed field.
    """
    auth_type = cfg.authType

    if auth_type == 'pat':
        token = str(cfg.token or '').strip()
        if not token:
            raise ValueError('tool_github: token is required')
        return {'authType': 'pat', 'token': token}

    app_id = str(cfg.appId or '').strip()
    private_key_pem = _decode_pem_blob(cfg.privateKey)
    installation_id = str(cfg.installationId or '').strip()
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


def _read_tools(raw) -> frozenset:
    """Parse the ``tools`` allowlist into a set of names; empty means every tool.

    The schema types the stored value as an array of the known names; this
    turns it into the set the instance publishes and fails closed on a list
    of blank entries. ``validate_tool_names`` checks the names.
    """
    if raw is None:
        return frozenset()
    if not isinstance(raw, (list, tuple)) or not all(isinstance(name, str) for name in raw):
        raise ValueError('tool_github: tools must be a list of tool names')
    names = frozenset(name.strip() for name in raw if name.strip())
    if raw and not names:
        # Entries that are all blank are a mistake, not a request for every tool: fail closed.
        raise ValueError(
            'tool_github: tools has only blank entries; name the tools to publish, or leave tools empty to publish every tool'
        )
    return names


def _read_options(cfg) -> dict:
    """Read the non-auth options of the resolved config (the scalars arrive validated)."""
    return {
        'tools': validate_tool_names(_read_tools(cfg.tools)),
        'graphqlAllowMutations': cfg.graphqlAllowMutations,
        'graphqlMaxResponseBytes': cfg.graphqlMaxResponseBytes,
        'rateLimitBudgetSeconds': cfg.rateLimitBudgetSeconds,
        'rateLimitMaxRetries': cfg.rateLimitMaxRetries,
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
    tools: frozenset = frozenset()
    graphql_max_bytes: int = github_client.DEFAULT_GRAPHQL_MAX_BYTES
    graphql_allow_mutations: bool = False
    retry_policy: github_client.RetryPolicy = github_client.RetryPolicy()

    _cached_token: str = ''
    _cached_expiry: float = 0.0
    _refresh_failed_at: float = 0.0
    _lock: threading.Lock

    def beginGlobal(self) -> None:
        # The resolved config: the active authType branch flattened beside the
        # options, every scalar typed and ranged by the schema
        cfg = self.config
        self.default_repo = str(cfg.defaultRepo or '').strip()
        self.read_only = cfg.readOnly
        self._cached_token = ''
        self._cached_expiry = 0.0
        self._refresh_failed_at = 0.0
        self._lock = threading.Lock()

        options = _read_options(cfg)
        self.tools = options['tools']
        self.graphql_max_bytes = options['graphqlMaxResponseBytes']
        self.graphql_allow_mutations = options['graphqlAllowMutations']
        self.retry_policy = github_client.RetryPolicy(
            budget_seconds=options['rateLimitBudgetSeconds'],
            max_retries=options['rateLimitMaxRetries'],
        )

        auth = _read_auth(cfg)
        self.auth_type = auth['authType']
        if self.auth_type == 'app':
            self.app_id = auth['appId']
            self.private_key_pem = auth['privateKeyPem']
            self.installation_id = auth['installationId']
        else:
            self.token = auth['token']

    def endGlobal(self) -> None:
        self.auth_type = 'pat'
        self.token = ''
        self.app_id = ''
        self.private_key_pem = ''
        self.installation_id = ''
        self.default_repo = ''
        self.read_only = False
        self.tools = frozenset()
        self.graphql_max_bytes = github_client.DEFAULT_GRAPHQL_MAX_BYTES
        self.graphql_allow_mutations = False
        self.retry_policy = github_client.RetryPolicy()
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
