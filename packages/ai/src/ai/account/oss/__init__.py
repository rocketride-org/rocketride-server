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
# Single shared secret from RR_APIKEY — no database, no OAuth.
# =============================================================================

"""
OSS (open-source) Account implementation.

This module provides a minimal ``Account`` class used when the proprietary
``account/auth/`` subpackage has not been overlaid by a SaaS build.

Authentication is performed against the ``RR_APIKEY`` environment variable,
the server's own setting (``ROCKETRIDE_APIKEY`` is the key a CLIENT sends;
see ``ai.common.server_env``).  All
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

import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

from rocketlib import debug

from ..base import ENV_MASK, AccountBase, InventoryUnavailableError, env_changes


def _env_line(name: str, value: str) -> str:
    """
    A .env line that load_dotenv reads back as the same value.

    Single quotes keep '#', spaces and double quotes literal; inside them a
    backslash and a single quote are escaped. '${' is refused before this.
    """
    escaped = value.replace('\\', '\\\\').replace("'", "\\'")
    return f"{name}='{escaped}'\n"


def _env_changes(args: Dict[str, Any]) -> Tuple[Dict[str, Optional[str]], Optional[str]]:
    """
    The changes an ``update_env`` / ``set_env`` request asks for.

    Args:
        args: The request arguments: ``env`` (name to value) and ``delete`` (names).

    Returns:
        The changes (a name to its value, None to delete) and None, or an
        empty dict and the error text when a name or value is refused.
    """
    try:
        changes = env_changes(args)
    except ValueError as e:
        return {}, str(e)
    # A .env line ends at a line break, the environment at a NUL, and
    # load_dotenv expands '${', quoted or not
    if any(v is not None and (any(c in v for c in '\0\r\n') or '${' in v) for v in changes.values()):
        return {}, (
            "Environment values cannot contain a line break, NUL or '${' (the .env loader expands it); nothing was saved."
        )
    return changes, None


def _merged_env(changes: Dict[str, Optional[str]], fold_case: bool) -> Tuple[Dict[str, str], Optional[str]]:
    """
    The ROCKETRIDE_* environment once ``changes`` are merged into the stored one.

    Args:
        changes:   From ``_env_changes``: a value sets, None deletes, the mask keeps.
        fold_case: True on Windows, where the environment lists every name
                   upper-cased: a sent name then addresses the stored one.

    Returns:
        The merged names and values and None, or an empty dict and the error
        text when the mask names nothing stored, one variable is sent under
        two names that differ only in case (fold_case), or the locale cannot
        hold a name or value.
    """
    env = {k: v for k, v in os.environ.items() if k.startswith('ROCKETRIDE_')}
    if fold_case:
        folded: Dict[str, List[str]] = {}
        for k in changes:
            folded.setdefault(k.upper(), []).append(k)
        # Two sent names that differ only in case are one variable here, stored or new
        twice = sorted(name for sent in folded.values() if len(sent) > 1 for name in sent)
        if twice:
            return {}, (
                'One variable sent under more than one name: ' + ', '.join(twice) + '. Send it once; nothing was saved.'
            )
        changes = {(k.upper() if k.upper() in env else k): v for k, v in changes.items()}
    unmasked = sorted(k for k, v in changes.items() if v == ENV_MASK and k not in env)
    if unmasked:
        return {}, 'No stored value to keep for: ' + ', '.join(unmasked) + '. Send a value; nothing was saved.'
    for name, value in changes.items():
        if value is None:
            env.pop(name, None)
        elif value != ENV_MASK:
            env[name] = value

    # A name or value the process environment cannot hold (a non-ASCII
    # one under an ASCII locale) is refused before anything is written
    try:
        for name, value in env.items():
            os.environ.encodekey(name)
            os.environ.encodevalue(value)
    except UnicodeError:
        return {}, "A name or value cannot be held in this engine's environment (its locale); nothing was saved."
    return env, None


# The ONE developer id (address namespace) of a standalone server: every
# task address and every published artifact on this install lives under it.
CONST_DEVELOPER_ID = 'rocketride'

# A server with the client's key name and not its own: configured for a key,
# so it neither starts nor accepts a login until the operator names the key.
_CLIENT_KEY_ONLY = (
    'This server reads its API key from RR_APIKEY. ROCKETRIDE_APIKEY is the key a client '
    'sends; set RR_APIKEY to the key this server requires (or unset both for an open local server).'
)


class Account(AccountBase):
    """
    Open-source authentication and account management.

    Authentication:   RR_APIKEY environment variable.
    Account mgmt:     Not available — all methods raise NotImplementedError.
    """

    capabilities = ('oss',)

    # No review ladder on a single-operator server: the developer IS the
    # admin, so @public publishes directly (app_deploy skips the 'ready'
    # gate; the 'failed'/built gates still apply).
    review_ladder = False

    # =========================================================================
    # AUTH
    # =========================================================================

    async def authenticate(self, credential: str) -> Union[Any, Tuple[int, str]]:
        """
        Authenticate a credential against the ``RR_APIKEY`` environment variable.

        Uses ``hmac.compare_digest`` for a constant-time comparison that avoids
        leaking the secret key length or content via timing side-channels.

        Args:
            credential (str): The raw API key supplied by the connecting client.

        Returns:
            AccountInfo: A fully-populated AccountInfo for the local developer
                identity if the credential matches.
            Tuple[int, str]: A ``(401, message)`` error tuple if authentication
                fails, or when only the client's ``ROCKETRIDE_APIKEY`` is set
                (``init_account`` refuses that start; this refuses it again).
        """
        # Import AccountInfo here (not at module level) to avoid a circular
        # import because ai.account.__init__ imports this module.
        from ai.account.models import AccountInfo

        # Step 1: the server's key; empty means authentication is not
        # configured and every credential is accepted. Never fall open on the
        # client's spelling: a server that has only ROCKETRIDE_APIKEY was
        # configured for a key and must not start accepting anyone
        oss_key = os.environ.get('RR_APIKEY', '')
        if not oss_key and os.environ.get('ROCKETRIDE_APIKEY'):
            return (401, _CLIENT_KEY_ONLY)

        # Step 2: a configured key must match, compared in constant time.
        # Whatever is in RR_APIKEY is the key; rotation is the operator's
        if oss_key and not hmac.compare_digest(oss_key.encode('utf-8'), (credential or '').encode('utf-8')):
            return (401, 'Invalid API key')

        # The app list: a registry that cannot answer must never block
        # sign-in — the connect proceeds with no apps (the shell has nothing
        # to register), and the desktop is NOT seeded from the outage.
        try:
            apps = await self._assemble_apps()
        except InventoryUnavailableError:
            apps = []

        # Credential matched — synthesise a local AccountInfo that grants the
        # connecting developer full admin access to the single 'local' team.
        info = AccountInfo(
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
            teamOrder=['local'],
            # Single synthetic organisation with org.admin so that
            # resolve_team_permissions expands to the full permission set.
            organization={
                'id': 'local',
                'name': 'Local',
                # Standalone publishes under the shared platform namespace:
                # anyone running the OSS server can deploy modified
                # rocketride.* apps to any of their own server's rungs —
                # including @public, which publishes directly here
                # (review_ladder=False above; no review on a
                # single-operator server). Upstreaming a change to the
                # common apps still happens via PR, and every rung is local
                # to this install, so the namespace grant never leaves it.
                'developerId': CONST_DEVELOPER_ID,
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
            # OSS: full manifest entries, free, with the user's real desktop
            # membership (seeded with the whole inventory on the first
            # sign-in) — so the shell can register MF remotes after auth. The
            # scope walk resolves EVERY app (built-ins are seeded registry
            # rows) so the INITIAL connect sees them, not just refreshes.
            apps=apps,
            capabilities=self.capabilities,
        )
        # The desktop's agents (plan 9.1, Step 6b.4): the pipe addresses on
        # the stored list, each as this identity reaches it now. Resolved
        # with the identity itself (the one resolver needs the caller), so
        # appended once it exists; never fails the sign-in.
        tiles = await self.desktop_pipe_tiles(info)
        if tiles:
            info.apps = [*info.apps, *tiles]
        return info

    async def _assemble_apps(self) -> List[Dict]:
        """The full OSS app list — registry-only (single source of truth).

        Built-ins are seeded into the deployment registry at init
        (``_seed_builtin_apps``), so runtime assembly never consults
        apps.json: every app — seeded or user-published — resolves through
        the ONE scope walk over the publish bindings. Dev previews are
        LOCAL-FIRST (client-side registration in the preview page) — no
        server-side overlay exists. OSS decoration (``decorate_desktop``):
        everything is free; ``onDesktop`` is the local user's stored desktop,
        seeded with this whole inventory on the first sign-in.

        Raises:
            InventoryUnavailableError: The registry did not answer. Distinct
                from an empty inventory so no caller seeds a desktop from an
                outage; the first successful assembly seeds.
        """
        from ai.account.app_deploy import resolve_app_pins

        try:
            # strict: the resolver's own publish_list guard answers [] to
            # every other caller; here an outage must stay distinguishable
            # from an empty inventory (the desktop seeds from this list).
            entries = await resolve_app_pins('local', 'local', ['local'], strict=True)
        except InventoryUnavailableError:
            raise
        except Exception as exc:
            # A broken publish store must never block sign-in — but say so,
            # and say it as a failure, never as "no apps".
            debug(f'[oss] app pin resolution failed: {exc}')
            raise InventoryUnavailableError(str(exc)) from exc
        # Skip ONE malformed pin, not the whole set. A genuinely empty
        # inventory still seeds (an empty desktop is a real answer).
        apps: List[Dict] = [entry for entry in entries if entry.get('id')]
        try:
            return await self.decorate_desktop('local', 'local', apps)
        except Exception as exc:
            # A desktop store that cannot be read must not block sign-in
            # either: the inventory is shown, nothing is marked on the
            # desktop, and the next read seeds again.
            debug(f'[oss] desktop read failed: {exc}')
            for entry in apps:
                entry['appStatus'] = 'free'
                entry['onDesktop'] = False
            return apps

    # =========================================================================
    # INIT — seed built-ins into the registry (apps.json is the seed)
    # =========================================================================

    async def init_account(self, server) -> None:
        """
        OSS startup: refuse a server configured with only the client's key name, then seed the built-in apps.

        Single process, so seeding rides the init sequence directly (SaaS
        runs the shared seeder from its pod-deploy tool instead — many pods
        must not race at boot). Seeding failures never block startup: the
        engine is useful without the app rail.

        Args:
            server: ``WebServer`` instance (unused by OSS).

        Raises:
            SystemExit: ``ROCKETRIDE_APIKEY`` is set and ``RR_APIKEY`` is not;
                the server would otherwise accept every credential.
        """
        # Step 1: a key configured under the client's name is the one start
        # this server refuses; serving would accept everyone
        if not os.environ.get('RR_APIKEY') and os.environ.get('ROCKETRIDE_APIKEY'):
            raise SystemExit(_CLIENT_KEY_ONLY)

        # Step 2: the built-in apps
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
          session pins on them survive). "Behind" is EITHER the manifest
          version string moving OR the built bundle's digest differing from
          the newest seed's recorded bundleSha256 — version strings lie when
          an upgrade ships a rebuilt bundle without a bump, and the digest is
          the truth. A seed row predating the digest field reads as changed
          (one re-seed records it). Neither trigger fires while the public
          rung serves a user's direct deploy: a release never repoints that.
        - rail rows but NO seed rows (a user deployed the id first) ->
          force: bind the public rung to a fresh SEED version, never to a
          user row
        """
        from ai.account.seed_apps import (
            PUBLIC_AUDIENCE,
            SEED_COMMENT,
            SYSTEM_ACTOR,
            bundle_digest,
            load_manifest_entries,
            public_serves_user_deploy,
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
                        metadata = seeds[0].get('metadata') if isinstance(seeds[0].get('metadata'), dict) else {}
                        stored = ((metadata or {}).get('manifest') or {}).get('version')
                        shipped = entry.get('version')
                        version_moved = bool(shipped) and str(stored or '') != str(shipped)
                        # The digest trigger: an upgrade that rebuilt the
                        # bundle without bumping the manifest version must
                        # still march. No local bundle = nothing to compare
                        # (never force); a seed row without a digest reads
                        # as changed, so one re-seed records it.
                        build = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
                        local = bundle_digest(str(app_id))
                        digest_changed = local is not None and build.get('bundleSha256') != local
                        if version_moved or digest_changed:
                            # Neither trigger may repoint a public rung that
                            # serves someone's deliberate deploy (the same
                            # guard bundle_changed honors).
                            public = await self.publish_get('local', 'app', str(app_id), PUBLIC_AUDIENCE)
                            force = not public_serves_user_deploy(rows, public)
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

    async def set_team_order(self, user_id: str, order: List[str]):
        self._saas_only()

    async def set_home_team(self, user_id: str, team_id: str):
        self._saas_only()

    async def list_keys(self, user_id: str) -> List:
        self._saas_only()

    async def create_key(self, **kw):
        self._saas_only()

    async def revoke_key(self, key_id: str, user_id: str):
        self._saas_only()

    async def get_organization(self, org_id: str) -> Optional[Dict]:
        self._saas_only()

    async def get_developer_id(self, org_id: str) -> Optional[str]:
        """The fixed standalone namespace — there is one org and it is this one."""
        return CONST_DEVELOPER_ID

    async def update_organization(self, org_id: str, name: str):
        self._saas_only()

    async def create_organization(self, **kw):
        self._saas_only()

    async def delete_org_precheck(self, org_id: str):
        self._saas_only()

    async def delete_organization(self, **kw):
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
    # (ROCKETRIDE_DB_BROKER_URL/_TOKEN); raises NotImplementedError when
    # the environment is not configured — the open-source default.

    # =========================================================================
    # APP MANIFEST — registry-only resolution (apps.json is only the seed)
    # =========================================================================

    async def get_public_apps(self) -> list:
        """
        Return apps visible to unauthenticated users.

        Registry-only: walks the public publish rung and hides entries whose
        seeded manifest declared ``public: false`` (the binding snapshot
        carries the flag on the file backend). Dev previews are LOCAL-FIRST
        (the preview page registers the app client-side) — nothing applies
        on top here.

        Returns:
            List of app manifest dicts.
        """
        from ai.account.app_deploy import resolve_app_pins

        try:
            # Snapshot 'public' flags live on the binding rows; the walk
            # output does not carry them, so read both and subtract.
            rows = await self.publish_list('local', 'app', [{'type': 'public', 'id': ''}])
            hidden = {r.get('appId') for r in rows if (r.get('snapshot') or {}).get('public', True) is False}
            entries = [e for e in await resolve_app_pins('local', None, []) if e.get('id') not in hidden]
        except Exception as exc:
            debug(f'[oss] public app resolution failed: {exc}')
            entries = []
        return entries

    async def get_apps_for_user(self, user_id: str, organizations: list) -> list:
        """
        Return all apps for an authenticated OSS user.

        Registry-only: the SAME single scope walk as the login assembly —
        built-ins are seeded rows, so there is no static merge and the two
        paths can never disagree. Raises ``InventoryUnavailableError`` when
        the registry did not answer (callers decorate without seeding).

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
        Handle ``rrext_account_me`` env subcommands and the empty publication breakdown.

        OSS supports ``get_env`` (the ROCKETRIDE_* names in os.environ, values
        masked) and ``update_env`` (merges into os.environ and the .env file: a
        value is set, None deletes, the mask keeps what is stored). ``set_env``
        is the same merge, for clients that predate ``update_env``.
        ``rrext_account_billing`` ``usage_by_publication`` answers the base's
        empty breakdown (no ledger standalone). All other account commands
        raise NotImplementedError.

        Args:
            conn:    TaskConn instance.
            request: DAP request dict.
        """
        command = request.get('command', '')
        args = request.get('arguments', {})
        sub = args.get('subcommand', '')

        if command == 'rrext_account_me':
            if sub == 'get_env':
                env = {k: ENV_MASK for k in os.environ if k.startswith('ROCKETRIDE_')}
                return conn.build_response(request, body={'env': env})

            # The SDKs send update_env, which a server with the old full-replacement
            # set_env refuses as unknown instead of wiping what it was not sent
            if sub in ('set_env', 'update_env'):
                changes, error = _env_changes(args)
                if error:
                    return conn.build_error(request, error)
                env, error = _merged_env(changes, os.name == 'nt')
                if error:
                    return conn.build_error(request, error)

                # Step 1: Persist to the .env file first, so a file that cannot be
                # read or written leaves memory as it was. Use sys.executable
                # (engine.exe path) — must match the load_dotenv path in server.py.
                import sys

                exec_dir = os.path.dirname(sys.executable)
                try:
                    self._write_env_file(os.path.join(exec_dir, '.env'), env)
                except (OSError, UnicodeError) as e:
                    return conn.build_error(request, f'The .env file could not be updated ({e}); nothing was saved.')

                # Step 2: Replace the ROCKETRIDE_* keys in os.environ, so deleted
                # keys don't linger and get_env reflects the change without a restart.
                for k in [k for k in os.environ if k.startswith('ROCKETRIDE_')]:
                    del os.environ[k]
                os.environ.update(env)
                return conn.build_response(request, body={'updated': True})

            if sub == 'env_keys':
                keys = sorted(k for k in os.environ if k.startswith('ROCKETRIDE_'))
                return conn.build_response(request, body={'keys': keys})

        # Served by publication answers its local shape: OSS keeps no ledger,
        # so the breakdown is the base's empty list, never an edition error
        if command == 'rrext_account_billing' and sub == 'usage_by_publication':
            rows = await self.get_usage_by_publication(args.get('orgId', ''))
            return conn.build_response(request, body={'usage': rows})

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
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    stripped = line.strip()
                    if stripped and not stripped.startswith('#') and '=' in stripped:
                        key = stripped.split('=', 1)[0].strip()
                        if key.startswith('ROCKETRIDE_'):
                            if key in env:
                                lines.append(_env_line(key, env[key]))
                                written_keys.add(key)
                            continue
                    lines.append(line)
        except FileNotFoundError:
            pass

        for k, v in sorted(env.items()):
            if k not in written_keys:
                lines.append(_env_line(k, v))

        # A symlinked .env is swapped at its target, so the link survives
        path = os.path.realpath(path)

        # Written whole to a temporary file, then swapped in: a failed write
        # leaves the old .env as it was
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.env.')
        try:
            with open(fd, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            if os.path.exists(path):
                os.chmod(tmp, os.stat(path).st_mode & 0o777)
            os.replace(tmp, path)
        except BaseException:
            os.unlink(tmp)
            raise
