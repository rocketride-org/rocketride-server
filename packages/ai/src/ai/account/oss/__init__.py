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

from rocketlib import debug

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
            devTeam='local',
            # Single synthetic organisation with org.admin so that
            # resolve_team_permissions expands to the full permission set.
            organization={
                'id': 'local',
                'name': 'Local',
                # Standalone publishes under the shared platform namespace:
                # anyone running the OSS server can deploy modified
                # rocketride.* apps to their own server's rungs (@me/@team) —
                # upstreaming a change to the common apps happens via PR, and
                # the @public rung stays unreachable without the SaaS review
                # ladder, so the namespace grant never leaves this install.
                'developerId': 'rocketride',
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
            # entries so the shell can register MF remotes after auth. The
            # scope walk resolves EVERY app (built-ins are seeded registry
            # rows) so the INITIAL connect sees them, not just refreshes.
            apps=await self._assemble_apps(),
            capabilities=self.capabilities,
        )

    async def _assemble_apps(self) -> List[Dict]:
        """The full OSS app list — registry-only (single source of truth).

        Built-ins are seeded into the deployment registry at init
        (``_seed_builtin_apps``), so runtime assembly never consults
        apps.json: every app — seeded or user-published — resolves through
        the ONE scope walk over the publish bindings, with the dev overlay
        applied on top. OSS decoration: everything is free and on the
        desktop.
        """
        from ai.account.app_deploy import resolve_app_pins
        from ai.account.dev_overlay import apply_overlay

        try:
            entries = await resolve_app_pins('local', 'local', ['local'])
        except Exception as exc:
            # A broken publish store must never block sign-in — but say so.
            debug(f'[oss] app pin resolution failed: {exc}')
            entries = []
        apps: List[Dict] = []
        for entry in entries:
            if not entry.get('id'):
                # Skip ONE malformed pin, not the whole set.
                continue
            entry['appStatus'] = 'free'
            entry['onDesktop'] = True
            apps.append(entry)
        return apply_overlay('local', apps)

    # =========================================================================
    # INIT — seed built-ins into the registry (apps.json is the seed)
    # =========================================================================

    async def init_account(self, server) -> None:
        """
        OSS startup: seed the built-in apps from apps.json into the registry.

        Single process, so seeding rides the init sequence directly (SaaS
        runs the shared seeder from its pod-deploy tool instead — many pods
        must not race at boot). Failures never block startup: the engine is
        useful without the app rail.

        Args:
            server: ``WebServer`` instance (unused by OSS).
        """
        try:
            await self._seed_builtin_apps()
        except Exception as exc:
            debug(f'[oss] built-in app seeding failed: {exc}')

    async def _seed_builtin_apps(self) -> None:
        """
        Seed absent built-ins and version-march changed ones.

        The OSS orchestration around the shared seeder:
        - no rail rows for an id     -> fresh seed (v1 + public binding)
        - seed rows current          -> no-op (binding self-heal only)
        - seed rows behind apps.json -> force: mint the NEXT version and
          repoint the public binding (append-only — older versions and any
          session pins on them survive)
        - rail rows but NO seed rows (a user deployed the id first) ->
          force: bind the public rung to a fresh SEED version, never to a
          user row
        """
        from ai.account.seed_apps import (
            SEED_COMMENT,
            SYSTEM_ACTOR,
            load_manifest_entries,
            seed_manifest_app,
        )

        try:
            entries = load_manifest_entries()
        except FileNotFoundError as exc:
            debug(f'[oss] app seed skipped: {exc}')
            return
        seeded = 0
        for entry in entries:
            app_id = entry.get('id')
            if not app_id:
                continue
            try:
                # Step 1: decide the per-app policy (see docstring).
                force = False
                rows = await self.deployments_versions('local', str(app_id))
                if rows:
                    # Rows are newest-first; the newest SEED row carries the
                    # manifest this install last seeded for the app.
                    seeds = [r for r in rows if r.get('comment') == SEED_COMMENT]
                    if not seeds:
                        force = True
                    else:
                        stored = (((seeds[0].get('metadata') or {}).get('manifest')) or {}).get('version')
                        shipped = entry.get('version')
                        force = bool(shipped) and str(stored or '') != str(shipped)
                # Step 2: run the shared seeder with that policy.
                if await seed_manifest_app(self, 'local', entry, SYSTEM_ACTOR, force=force):
                    seeded += 1
            except Exception as exc:
                debug(f'[oss] seed failed for {app_id}: {exc}')
        if seeded:
            debug(f'[oss] seeded/updated {seeded} built-in app(s)')

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

    async def set_dev_team(self, user_id: str, team_id: str):
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

    # resolve_db_dsn is inherited from AccountBase: env-gated broker call
    # (ROCKETRIDE_DB_BROKER_URL/_TOKEN); raises the cloud-sign-in error when
    # the environment is not configured — the open-source default.

    # =========================================================================
    # APP MANIFEST — registry-only resolution (apps.json is only the seed)
    # =========================================================================

    async def get_public_apps(self) -> list:
        """
        Return apps visible to unauthenticated users.

        Registry-only: walks the public publish rung and hides entries whose
        seeded manifest declared ``public: false`` (the binding snapshot
        carries the flag on the file backend). The dev overlay applies on
        top so a register_dev'd bundle previews pre-auth too.

        Returns:
            List of app manifest dicts.
        """
        from ai.account.app_deploy import resolve_app_pins
        from ai.account.dev_overlay import apply_overlay

        try:
            # Snapshot 'public' flags live on the binding rows; the walk
            # output does not carry them, so read both and subtract.
            rows = await self.publish_list('local', 'app', [{'type': 'public', 'id': ''}])
            hidden = {r.get('appId') for r in rows if (r.get('snapshot') or {}).get('public', True) is False}
            entries = [e for e in await resolve_app_pins('local', None, []) if e.get('id') not in hidden]
        except Exception as exc:
            debug(f'[oss] public app resolution failed: {exc}')
            entries = []
        return apply_overlay('local', entries)

    async def get_apps_for_user(self, user_id: str, organizations: list) -> list:
        """
        Return all apps for an authenticated OSS user.

        Registry-only: the SAME single scope walk as the login assembly —
        built-ins are seeded rows, so there is no static merge and the two
        paths can never disagree.

        Args:
            user_id:       Internal user ID (always 'local' in OSS).
            organizations: List of org dicts (single 'local' org in OSS).

        Returns:
            List of all app manifest dicts.
        """
        return await self._assemble_apps()

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
