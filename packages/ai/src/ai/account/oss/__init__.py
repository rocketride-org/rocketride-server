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

# =============================================================================
# OPEN-SOURCE ACCOUNT
# Used when the `account/auth/` SaaS subpackage is not present.
# Single shared secret from ROCKETRIDE_APIKEY — no database, no OAuth.
# =============================================================================

"""
OSS (open-source) Account implementation.

This module provides a minimal ``Account`` class used when the proprietary
``account/auth/`` subpackage has not been overlaid by a SaaS build.

Authentication is performed against the ``ROCKETRIDE_APIKEY`` environment
variable using a constant-time comparison to prevent timing attacks.  All
account-management methods (user profile, API keys, organisations, teams,
billing) raise ``NotImplementedError`` because they require the SaaS backend.

The single authenticated identity is a local "Developer" user who belongs to
a synthetic ``local`` organisation and team with full admin permissions.
"""

import hmac
import os
from depends import depends as _depends

# Install any OSS-specific Python dependencies declared in the sibling
# requirements.txt before importing anything else from this module.
_depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from typing import Any, Dict, List, Optional, Tuple, Union


class Account:
    """
    Open-source authentication and account management.

    Authentication:   ROCKETRIDE_APIKEY environment variable.
    Account mgmt:     Not available — all methods raise NotImplementedError.
    """

    # =========================================================================
    # AUTH
    # =========================================================================

    async def authenticate(self, credential: str) -> Union[Any, Tuple[int, str]]:
        """
        Authenticate a credential against the ``ROCKETRIDE_APIKEY`` environment variable.

        Uses ``hmac.compare_digest`` for a constant-time comparison that avoids
        leaking the secret key length or content via timing side-channels.

        Args:
            credential (str): The raw API key supplied by the connecting client.

        Returns:
            AccountInfo: A fully-populated AccountInfo for the local developer
                identity if the credential matches.
            Tuple[int, str]: A ``(401, message)`` error tuple if authentication
                fails or no key has been configured.
        """
        # Import AccountInfo here (not at module level) to avoid a circular
        # import because ai.account.__init__ imports this module.
        from ai.account.models import AccountInfo

        # Read the expected key from the environment; empty string means
        # authentication has not been configured at all.
        oss_key = os.environ.get('ROCKETRIDE_APIKEY', '')
        if not oss_key:
            # No key configured — reject the connection immediately.
            return (401, 'No authentication configured — set ROCKETRIDE_APIKEY')
        if not hmac.compare_digest(credential, oss_key):
            # Key was configured but did not match — reject with a generic message
            # that does not reveal whether the key exists or its value.
            return (401, 'Invalid API key')

        # Credential matched — synthesise a local AccountInfo that grants the
        # connecting developer full admin access to the single 'local' team.
        return AccountInfo(
            auth=credential,
            userToken=credential,
            userId='local',
            displayName='Developer',
            givenName='',
            familyName='',
            preferredUsername='developer',
            email='',
            emailVerified=False,
            phoneNumber='',
            phoneNumberVerified=False,
            locale='',
            defaultTeam='local',
            # Single synthetic organisation with org.admin so that
            # resolve_team_permissions expands to the full permission set.
            organizations=[
                {
                    'id': 'local',
                    'name': 'Local',
                    'permissions': ['org.admin'],
                    'teams': [
                        {
                            'id': 'local',
                            'name': 'Development',
                            'permissions': ['team.admin', 'read', 'write', 'execute', 'task.control', 'task.data', 'task.monitor', 'task.debug', 'task.store'],
                        }
                    ],
                }
            ],
        )

    # =========================================================================
    # ACCOUNT MANAGEMENT  (not available in OSS)
    # =========================================================================

    def _saas_only(self) -> None:
        """
        Raise NotImplementedError to signal that the called method requires the SaaS build.

        Every account-management stub delegates here so that the error message
        is consistent and the stubs themselves remain one-liners.

        Raises:
            NotImplementedError: Always.
        """
        raise NotImplementedError('Account management requires SaaS mode')

    # The following methods are intentionally stub implementations.  Each
    # delegates immediately to _saas_only() which raises NotImplementedError.
    # They are declared so that type-checkers and callers can reference them
    # without needing to guard on which Account implementation is active.

    async def get_user_profile(self, user_id: str) -> Dict:
        self._saas_only()

    async def update_user(self, user_id: str, display_name: str):
        self._saas_only()

    async def set_default_team(self, user_id: str, team_id: str):
        self._saas_only()

    async def list_keys(self, user_id: str) -> List:
        self._saas_only()

    async def create_key(self, **kw):
        self._saas_only()

    async def revoke_key(self, key_id: str, user_id: str):
        self._saas_only()

    async def get_organization(self, org_id: str) -> Optional[Dict]:
        self._saas_only()

    async def update_organization(self, org_id: str, name: str):
        self._saas_only()

    async def list_org_members(self, org_id: str) -> List:
        self._saas_only()

    async def invite_org_member(self, **kw):
        self._saas_only()

    async def update_org_member(self, **kw):
        self._saas_only()

    async def remove_org_member(self, **kw):
        self._saas_only()

    async def is_org_admin(self, **kw) -> bool:
        self._saas_only()

    async def list_teams(self, org_id: str) -> List:
        self._saas_only()

    async def create_team(self, **kw):
        self._saas_only()

    async def delete_team(self, team_id: str):
        self._saas_only()

    async def get_team(self, team_id: str) -> Dict:
        self._saas_only()

    async def add_team_member(self, **kw):
        self._saas_only()

    async def update_team_member(self, **kw):
        self._saas_only()

    async def remove_team_member(self, **kw):
        self._saas_only()

    # =========================================================================
    # TOKEN GENERATION  — used by task_server for pk_/tk_ task tokens
    # =========================================================================

    def generate_token(self, content: dict, prefix: str = '') -> str:
        """
        Generate a deterministic token from a content dict and optional prefix.

        The token is a 32-character hex digest of the SHA-256 hash of the
        JSON-serialised ``content`` dict (keys sorted for determinism),
        optionally prepended with ``prefix``.

        Args:
            content (dict): Arbitrary key/value data to hash.  Keys are sorted
                before serialisation so that the same logical content always
                produces the same token regardless of insertion order.
            prefix (str): Short string prepended to the hex digest (e.g. ``'pk_'``
                or ``'tk_'``).  Defaults to an empty string.

        Returns:
            str: ``f'{prefix}{hex_digest[:32]}'`` — a URL-safe opaque token.
        """
        import hashlib
        import json

        # Serialise the content dict with sorted keys to ensure that two dicts
        # with identical key/value pairs but different insertion orders produce
        # the same token.
        raw = json.dumps(content, sort_keys=True).encode('utf-8')

        # Compute the SHA-256 digest and truncate to 32 hex characters (128 bits),
        # which is sufficient entropy for a non-cryptographic task token.
        token = hashlib.sha256(raw).hexdigest()[:32]

        # Prepend the caller-supplied prefix (e.g. 'pk_' / 'tk_') so that
        # tokens can be identified by type at a glance.
        return f'{prefix}{token}'
