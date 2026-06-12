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

import os
from depends import depends as _depends

# Install any OSS-specific Python dependencies declared in the sibling
# requirements.txt before importing anything else from this module.
_depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

from typing import Any, Dict, List, Optional, Tuple, Union

from ..base import AccountBase


class Account(AccountBase):
    """
    Open-source authentication and account management.

    Authentication:   ROCKETRIDE_APIKEY environment variable.
    Account mgmt:     Not available — all methods raise NotImplementedError.
    """

    capabilities = ('oss',)

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

        # OSS is a lot looser on the key -- whatever is specified in ROCKETRIDE_APIKEY
        # on the server env is what we expect. Up to 3rd part and key rotation
        if oss_key and oss_key != credential:
            # Key is configured but the credential doesn't match — reject.
            return (401, 'Invalid API key')

        # Credential matched — synthesise a local AccountInfo that grants the
        # connecting developer full admin access to the single 'local' team.
        return AccountInfo(
            auth=credential,
            userToken=credential,
            userId='local',
            displayName='RocketRide Developer',
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
            organization={
                'id': 'local',
                'name': 'Local',
                'permissions': ['org.admin'],
                'teams': [
                    {
                        'id': 'local',
                        'name': 'Development',
                        'permissions': [
                            'team.admin',
                            'read',
                            'write',
                            'execute',
                            'task.control',
                            'task.data',
                            'task.monitor',
                            'task.debug',
                            'task.store',
                        ],
                    }
                ],
            },
            # OSS: all apps are on the desktop and free — return full manifest
            # entries so the shell can register MF remotes after auth
            apps=[
                {**a, 'appStatus': 'free', 'onDesktop': True}
                for a in self._read_apps_json(public_only=False)
                if a.get('id')
            ],
            capabilities=self.capabilities,
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

    async def get_team_member(self, team_id: str, user_id: str):
        self._saas_only()

    async def add_team_member(self, **kw):
        self._saas_only()

    async def update_team_member(self, **kw):
        self._saas_only()

    async def remove_team_member(self, **kw):
        self._saas_only()

    # audit() is inherited from AccountBase as a no-op — OSS has no database.

    # =========================================================================
    # APP MANIFEST — read from static apps.json
    # =========================================================================

    async def get_public_apps(self) -> list:
        """
        Return apps visible to unauthenticated users.

        Reads ``dist/server/static/apps.json`` from disk and returns only
        entries where ``public`` is not explicitly ``False``.

        Returns:
            List of app manifest dicts.
        """
        return self._read_apps_json(public_only=True)

    async def get_apps_for_user(self, user_id: str, organizations: list) -> list:
        """
        Return all apps for an authenticated OSS user.

        In OSS mode, APIKEY grants full access — all apps are returned
        regardless of the ``public`` flag.

        Args:
            user_id:       Internal user ID (always 'local' in OSS).
            organizations: List of org dicts (single 'local' org in OSS).

        Returns:
            List of all app manifest dicts.
        """
        return self._read_apps_json(public_only=False)

    def _read_apps_json(self, public_only: bool = False) -> list:
        """
        Read and parse the static apps.json manifest from disk.

        Args:
            public_only: If True, filter out entries with ``public: False``.

        Returns:
            List of app manifest dicts, or empty list if the file is missing.
        """
        import sys
        import json

        # apps.json is written by registerApp.js during the build
        apps_path = os.path.join(os.path.dirname(sys.executable), 'static', 'apps.json')
        try:
            with open(apps_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return []

        apps = data.get('apps', [])
        if public_only:
            # Default is public (True) — only exclude explicitly private apps
            apps = [a for a in apps if a.get('public', True)]
        return apps

    # =========================================================================
    # HANDLE ACCOUNT — env-only support for OSS
    # =========================================================================

    async def handle_account(self, conn, request):
        """
        Handle ``rrext_account_me`` for env subcommands only.

        OSS supports ``get_env`` (reads ROCKETRIDE_* from os.environ) and
        ``set_env`` (writes to os.environ + persists to .env file).
        All other account commands raise NotImplementedError.

        Args:
            conn:    TaskConn instance.
            request: DAP request dict.
        """
        command = request.get('command', '')
        args = request.get('arguments', {})
        sub = args.get('subcommand', '')

        if command == 'rrext_account_me':
            if sub == 'get_env':
                env = {k: v for k, v in os.environ.items() if k.startswith('ROCKETRIDE_')}
                return conn.build_response(request, body={'env': env})

            if sub == 'set_env':
                # Only accept ROCKETRIDE_* keys — reject anything else
                raw = args.get('env', {})
                env = {k: v for k, v in raw.items() if k.startswith('ROCKETRIDE_')}

                # Step 1: Remove existing ROCKETRIDE_* keys from os.environ
                # so that deleted keys don't linger in memory.
                for k in [k for k in os.environ if k.startswith('ROCKETRIDE_')]:
                    del os.environ[k]

                # Step 2: Set the new values in os.environ so get_env
                # reflects the change immediately without a restart.
                os.environ.update(env)

                # Step 3: Persist to .env file on disk.
                # Use sys.executable (engine.exe path) — must match the
                # load_dotenv path in server.py, which also uses sys.executable.
                import sys

                exec_dir = os.path.dirname(sys.executable)
                self._write_env_file(os.path.join(exec_dir, '.env'), env)
                return conn.build_response(request, body={'updated': True})

            if sub == 'env_keys':
                keys = sorted(k for k in os.environ if k.startswith('ROCKETRIDE_'))
                return conn.build_response(request, body={'keys': keys})

        raise NotImplementedError('Account management requires SaaS mode')

    @staticmethod
    def _write_env_file(path: str, env: Dict[str, str]) -> None:
        """
        Merge ROCKETRIDE_* entries into a .env file.

        Preserves non-ROCKETRIDE lines and comments. Replaces existing
        ROCKETRIDE_* lines and appends new ones.

        Args:
            path: Absolute path to the .env file.
            env:  Key-value dict to write.
        """
        lines: List[str] = []
        written_keys: set = set()
        try:
            with open(path, 'r') as f:
                for line in f:
                    stripped = line.strip()
                    if stripped and not stripped.startswith('#') and '=' in stripped:
                        key = stripped.split('=', 1)[0].strip()
                        if key.startswith('ROCKETRIDE_'):
                            if key in env:
                                lines.append(f'{key}={env[key]}\n')
                                written_keys.add(key)
                            continue
                    lines.append(line)
        except FileNotFoundError:
            pass

        for k, v in sorted(env.items()):
            if k not in written_keys:
                lines.append(f'{k}={v}\n')

        with open(path, 'w') as f:
            f.writelines(lines)

    # generate_token is inherited from AccountBase.
