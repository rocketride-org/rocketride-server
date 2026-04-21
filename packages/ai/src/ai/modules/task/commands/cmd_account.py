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
# CMD ACCOUNT
# DAP command handler for account management operations.
# All write operations require Zitadel authentication (require_zitadel_auth).
# Read operations require only the standard DAP API key authentication.
# Permissions are resolved from self._account_info.organizations (set at connect time).
# =============================================================================

"""
AccountCommands: DAP command handler for account and billing management.

This module implements the ``AccountCommands`` mixin class which is blended into
the main DAP connection handler.  It exposes six top-level DAP commands, each of
which dispatches to a named subcommand:

- ``rrext_account_me``      — user profile (get, update)
- ``rrext_account_keys``    — API keys (list, create, revoke)
- ``rrext_account_org``     — organisation info (get, update)
- ``rrext_account_members`` — org members (list, invite, update, remove)
- ``rrext_account_teams``   — teams (list, create, delete, get, add_member,
                               update_member, remove_member)
- ``rrext_account_billing`` — billing / plan info (get, checkout, portal)

All write operations additionally require Zitadel authentication (OAuth access
token, not just an API key) so that session-hijacking an API key is not
sufficient to modify account data.
"""

from typing import TYPE_CHECKING, Dict, Any, Optional
from ai.common.dap import DAPConn, TransportBase
from ai.account import account
from ai.account.models import resolve_team_permissions
from rocketlib import debug

if TYPE_CHECKING:
    from ..task_server import TaskServer


class AccountCommands(DAPConn):
    """
    DAP command handler for account management.

    Exposes six command groups, each dispatching to named subcommands:
      - rrext_account_me        : user profile (get, update)
      - rrext_account_keys      : API keys (list, create, revoke)
      - rrext_account_org       : organization info (get, update)
      - rrext_account_members   : org members (list, invite, update, remove)
      - rrext_account_teams     : teams (list, create, delete, get, add_member, update_member, remove_member)
      - rrext_account_billing   : billing / plan info (get, checkout, portal)
    """

    def __init__(
        self,
        connection_id: int,
        server: 'TaskServer',
        transport: TransportBase,
        **kwargs,
    ) -> None:
        """
        Initialise AccountCommands.

        Args:
            connection_id (int): Unique identifier for this DAP connection.
            server (TaskServer): The central server that manages task instances
                and account state.
            transport (TransportBase): The low-level transport for DAP messages.
            **kwargs: Forwarded to the parent ``DAPConn`` constructor.
        """
        pass

    # =========================================================================
    # PERMISSION HELPERS
    # =========================================================================

    def _push(self, *user_ids: str) -> None:
        """Schedule an AccountInfo push to all open connections for each user_id."""
        import asyncio

        # Fire-and-forget an account push for every affected user so that any
        # other open connections belonging to these users see the updated data
        # without needing to reconnect.
        for uid in user_ids:
            if uid:
                asyncio.ensure_future(self._server.push_account_update(uid))

    def _require_org(self, org_id: Optional[str] = None) -> str:
        """
        Return the org_id the caller has access to.
        If org_id is supplied, verify the caller belongs to it.
        Otherwise fall back to the first org in their organizations list.

        Args:
            org_id (Optional[str]): The organisation ID to verify membership of.
                If ``None``, the first organisation in ``_account_info.organizations``
                is returned without explicit verification.

        Returns:
            str: The validated (or defaulted) organisation ID.

        Raises:
            PermissionError: If the caller belongs to no organisations, or if
                ``org_id`` was supplied but the caller is not a member.
        """
        # Retrieve the list of orgs from the session; default to empty list
        # if the field is absent or falsy.
        orgs = self._account_info.organizations or []
        if not orgs:
            raise PermissionError('No organization associated with this account')

        if org_id:
            # Caller explicitly specified an org — verify they are a member.
            for org in orgs:
                if org.get('id') == org_id:
                    return org_id
            # The requested org was not found in the caller's membership list.
            raise PermissionError(f'Access denied to organization {org_id!r}')

        # No org_id supplied — default to the first org the caller belongs to.
        return orgs[0]['id']

    def _require_org_admin(self, org_id: str) -> None:
        """Raise PermissionError if caller is not an org admin of org_id.

        Args:
            org_id (str): The organisation whose admin membership should be
                verified.

        Raises:
            PermissionError: If the caller does not hold the ``org.admin``
                permission within ``org_id``, or is not a member at all.
        """
        # Walk the caller's organisations looking for a matching org.
        for org in self._account_info.organizations or []:
            if org.get('id') == org_id:
                # Org found — check for the admin permission.
                if 'org.admin' in org.get('permissions', []):
                    return
                raise PermissionError('Only organization admins can perform this operation')
        # The org was not found in the caller's membership list at all.
        raise PermissionError(f'Access denied to organization {org_id!r}')

    def _require_team_admin(self, team_id: str) -> None:
        """Raise PermissionError if caller lacks team.admin on team_id (org.admin also satisfies).

        Args:
            team_id (str): The team whose admin membership should be verified.

        Raises:
            PermissionError: If the caller does not hold ``team.admin`` (or
                ``org.admin``) for ``team_id``, or is not a member of the team.
        """
        try:
            # Resolve the full effective permission list for this team.
            # resolve_team_permissions raises PermissionError if the caller
            # is not a member of the team at all.
            perms = resolve_team_permissions(self._account_info, team_id)
            if 'team.admin' not in perms:
                raise PermissionError('Only team admins can perform this operation')
        except PermissionError as e:
            # Re-raise with the original message so callers see a consistent error.
            raise PermissionError(str(e))

    # =========================================================================
    # RREXT_ACCOUNT_ME  — user profile
    # =========================================================================

    async def on_rrext_account_me(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_me`` DAP command.

        Dispatches to one of two subcommands based on the ``subcommand`` argument:

        - ``get``    — return the current user's profile
        - ``update`` — modify the current user's profile (requires Zitadel auth)

        Args:
            request (Dict[str, Any]): DAP request containing an ``arguments`` dict
                with at least a ``subcommand`` key.

        Returns:
            Dict[str, Any]: DAP response produced by the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        # Extract the arguments block (default to empty dict for safety).
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')

        # Route to the appropriate handler based on the subcommand string.
        if subcommand == 'get':
            return await self._me_get(request)
        elif subcommand == 'update':
            return await self._me_update(request, args)
        elif subcommand == 'set_default_team':
            return await self._me_set_default_team(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _me_get(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Return the authenticated user's full ConnectResult."""
        # Serialise the session AccountInfo (minus the raw auth credential)
        # and wrap it in a DAP response envelope.
        return self.build_response(request, body=self._account_info.to_connect_result())

    async def _me_update(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Update the authenticated user's profile fields. Requires Zitadel auth.

        Args:
            request (Dict[str, Any]): Original DAP request (used to build response).
            args (Dict[str, Any]): Parsed ``arguments`` block from the request.
                Recognised optional keys: ``displayName``, ``givenName``,
                ``familyName``, ``preferredUsername``, ``email``,
                ``phoneNumber``, ``locale``.

        Returns:
            Dict[str, Any]: DAP response containing the updated profile fields.
        """
        # Write operations require a Zitadel OAuth token, not just an API key.
        self.require_zitadel_auth()
        user_id = self._account_info.userId

        # Only pass fields that were explicitly provided — None means "don't change"
        def _field(key: str):
            # Return the value from args if the key exists, otherwise None so
            # that the account backend leaves the field unchanged.
            return args[key] if key in args else None

        # Call the account backend with only the fields the caller provided.
        user = await account.update_user(
            user_id,
            display_name=_field('displayName'),
            given_name=_field('givenName'),
            family_name=_field('familyName'),
            preferred_username=_field('preferredUsername'),
            email=_field('email'),
            phone_number=_field('phoneNumber'),
            locale=_field('locale'),
        )

        # Notify all other connections for this user so they see the new profile.
        self._push(user_id)

        # Return the updated fields to the caller in a normalised format.
        return self.build_response(
            request,
            body={
                'userId': user.id,
                'displayName': user.display_name or '',
                'givenName': user.given_name or '',
                'familyName': user.family_name or '',
                'preferredUsername': user.preferred_username or '',
                'email': user.email or '',
                'phoneNumber': user.phone_number or '',
                'locale': user.locale or '',
            },
        )

    async def _me_set_default_team(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle the ``set_default_team`` subcommand of ``rrext_account_me``.

        Writes the caller's preferred default team to the database, then
        schedules an ``apaext_account`` push event so all open connections for
        this user receive a refreshed ``ConnectResult`` containing the updated
        ``defaultTeam`` field.  The response body is intentionally empty — the
        client should rely on the push event for the updated identity rather than
        reading the response body.

        Args:
            request: Original DAP request envelope used to build the response.
            args: Parsed ``arguments`` block from the request.  Must contain
                  ``teamId`` — the ID of the team to mark as default.

        Returns:
            DAP success response with an empty body.

        Raises:
            ValueError: If ``teamId`` is missing, the user does not exist, or the
                        user is not a member of the specified team.
        """
        # Validate that the caller supplied a team ID — empty string is rejected.
        team_id = args.get('teamId', '')
        if not team_id:
            raise ValueError('teamId is required')

        # Resolve the authenticated user from the current connection context.
        user_id = self._account_info.userId

        # Persist the new default; raises ValueError if the user is not a member.
        await account.set_default_team(user_id, team_id)

        # Schedule an apaext_account push so every open connection for this user
        # receives a fresh ConnectResult — the "✓ Default" indicator flips
        # in the UI without requiring a page reload or manual refresh.
        self._push(user_id)

        return self.build_response(request, body={})

    # =========================================================================
    # RREXT_ACCOUNT_KEYS  — API key management
    # =========================================================================

    async def on_rrext_account_keys(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_keys`` DAP command.

        Dispatches to one of three subcommands:

        - ``list``   — list all API keys for the current user
        - ``create`` — create a new API key (requires Zitadel auth)
        - ``revoke`` — revoke an existing API key (requires Zitadel auth)

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.subcommand``.

        Returns:
            Dict[str, Any]: DAP response from the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')

        # Dispatch based on the subcommand string.
        if subcommand == 'list':
            return await self._keys_list(request)
        elif subcommand == 'create':
            return await self._keys_create(request, args)
        elif subcommand == 'revoke':
            return await self._keys_revoke(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _keys_list(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """List all API keys for the authenticated user.

        Args:
            request (Dict[str, Any]): Original DAP request.

        Returns:
            Dict[str, Any]: DAP response with ``body.keys`` containing the list
                of key records.
        """
        # Identify the caller so we only return their own keys.
        user_id = self._account_info.userId
        keys = await account.list_keys(user_id)
        return self.build_response(request, body={'keys': keys})

    async def _keys_create(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create a new API key. Requires Zitadel auth.

        Arguments:
            teamId (str): Team to scope the key to.
            name (str): Human-readable label.
            permissions (list[str], optional): Permissions list. Defaults to ['*'].
            expiresAt (str, optional): ISO 8601 expiry timestamp.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments block.

        Returns:
            Dict[str, Any]: DAP response containing the new key record plus the
                ``key`` field holding the full plaintext secret.  This is the
                only time the plaintext secret is returned; it cannot be retrieved
                again.

        Raises:
            ValueError: If ``teamId`` or ``name`` is missing.
        """
        # A Zitadel token is required so that interactive login is needed to
        # create an API key — preventing key theft via a compromised API key.
        self.require_zitadel_auth()
        user_id = self._account_info.userId
        team_id = args.get('teamId')
        name = args.get('name')

        # Both teamId and name are mandatory — reject early with a clear message.
        if not team_id or not name:
            raise ValueError('teamId and name are required')

        # Default to full-access wildcard if no explicit permissions are given.
        permissions = args.get('permissions', ['*'])

        # Parse optional ISO 8601 expiry timestamp into a datetime object.
        expires_at = None
        if args.get('expiresAt'):
            from datetime import datetime

            expires_at = datetime.fromisoformat(args['expiresAt'])

        # Create the key via the account backend; returns both the DB record
        # and the once-visible plaintext secret.
        record, full_key = await account.create_key(
            user_id=user_id,
            team_id=team_id,
            name=name,
            permissions=permissions,
            expires_at=expires_at,
        )
        # Return the full key once — it will never be retrievable again
        return self.build_response(request, body={**record, 'key': full_key})

    async def _keys_revoke(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Revoke an API key by ID. Requires Zitadel auth.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments block.  Must contain ``keyId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.revoked`` set to ``True``.

        Raises:
            ValueError: If ``keyId`` is missing.
        """
        # Zitadel auth prevents an attacker with a stolen API key from revoking
        # other keys to lock the legitimate user out.
        self.require_zitadel_auth()
        user_id = self._account_info.userId
        key_id = args.get('keyId')
        if not key_id:
            raise ValueError('keyId is required')

        # Revoke the key; account backend verifies ownership (user_id must match).
        await account.revoke_key(key_id, user_id)
        return self.build_response(request, body={'revoked': True})

    # =========================================================================
    # RREXT_ACCOUNT_ORG  — organization info
    # =========================================================================

    async def on_rrext_account_org(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_org`` DAP command.

        Dispatches to one of two subcommands:

        - ``get``    — return organisation details
        - ``update`` — update organisation name (requires Zitadel auth and org.admin)

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.subcommand``.

        Returns:
            Dict[str, Any]: DAP response from the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')

        if subcommand == 'get':
            return await self._org_get(request, args)
        elif subcommand == 'update':
            return await self._org_update(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _org_get(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Return the organization the authenticated user belongs to.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments block.  May contain optional
                ``orgId`` to target a specific organisation.

        Returns:
            Dict[str, Any]: DAP response with the organisation record as the body.

        Raises:
            ValueError: If the organisation cannot be found in the backend.
        """
        # Validate access and resolve the org ID (falls back to default if omitted).
        org_id = self._require_org(args.get('orgId'))
        org = await account.get_organization(org_id)
        if not org:
            raise ValueError('Organization not found')
        return self.build_response(request, body=org)

    async def _org_update(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Update organization name. Requires Zitadel auth and org.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments block.  Must contain ``name``.
                May contain optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with the updated organisation record.

        Raises:
            ValueError: If ``name`` is missing.
            PermissionError: If the caller is not an org admin.
        """
        # Require interactive login for any mutating org operation.
        self.require_zitadel_auth()
        # Resolve and validate the org the caller wants to update.
        org_id = self._require_org(args.get('orgId'))
        # Verify the caller has org admin rights before touching the record.
        self._require_org_admin(org_id)
        name = args.get('name')
        if not name:
            raise ValueError('name is required')
        # Perform the update and return the new state.
        result = await account.update_organization(org_id, name)
        return self.build_response(request, body=result)

    # =========================================================================
    # RREXT_ACCOUNT_MEMBERS  — org member management
    # =========================================================================

    async def on_rrext_account_members(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_members`` DAP command.

        Dispatches to one of four subcommands:

        - ``list``   — list org members
        - ``invite`` — invite a new member by email (requires Zitadel auth + org.admin)
        - ``update`` — change a member's role (requires Zitadel auth + org.admin)
        - ``remove`` — remove a member (requires Zitadel auth + org.admin)

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.subcommand``.

        Returns:
            Dict[str, Any]: DAP response from the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')

        if subcommand == 'list':
            return await self._members_list(request, args)
        elif subcommand == 'invite':
            return await self._members_invite(request, args)
        elif subcommand == 'update':
            return await self._members_update(request, args)
        elif subcommand == 'remove':
            return await self._members_remove(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _members_list(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """List members of the user's organization.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.members`` list.
        """
        # Resolve and validate access to the target org.
        org_id = self._require_org(args.get('orgId'))
        members = await account.list_org_members(org_id)
        return self.build_response(request, body={'members': members})

    async def _members_invite(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Invite a user to the organization by email. Requires Zitadel auth and org.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``email``,
                ``givenName``, ``familyName``.  Optional: ``orgId``, ``role``
                (defaults to ``'member'``).

        Returns:
            Dict[str, Any]: DAP response with the newly created member record.

        Raises:
            ValueError: If any required argument is missing.
            PermissionError: If the caller is not an org admin.
        """
        # Interactive login required before sending any invitation.
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))
        # Only org admins may add new members.
        self._require_org_admin(org_id)

        # Extract and validate all required invitation fields.
        email = args.get('email')
        given_name = args.get('givenName', '')
        family_name = args.get('familyName', '')
        role = args.get('role', 'member')
        if not email:
            raise ValueError('email is required')
        if not given_name:
            raise ValueError('givenName is required')
        if not family_name:
            raise ValueError('familyName is required')

        # Create the member record in the backend and send the invitation email.
        member = await account.invite_org_member(org_id=org_id, email=email, given_name=given_name, family_name=family_name, role=role, invited_by=self._account_info.userId)

        # Push an account update to the newly invited user if they already have
        # an account (the push is a no-op if the userId is unknown / empty).
        self._push(member.get('userId', ''))
        return self.build_response(request, body=member)

    async def _members_update(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Update a member's role. Requires Zitadel auth and org.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``userId``
                and ``role``.  Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with the updated member record.

        Raises:
            ValueError: If ``userId`` or ``role`` is missing.
            PermissionError: If the caller is not an org admin.
        """
        # Require interactive login for any role-change operation.
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))
        self._require_org_admin(org_id)

        target_user_id = args.get('userId')
        role = args.get('role')
        if not target_user_id or not role:
            raise ValueError('userId and role are required')

        # Apply the role change; backend validates that the role value is valid.
        result = await account.update_org_member(org_id=org_id, user_id=target_user_id, role=role)

        # Notify the affected user so their next command sees the new permissions.
        self._push(target_user_id)
        return self.build_response(request, body=result)

    async def _members_remove(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Remove a member from the organization. Requires Zitadel auth and org.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``userId``.
                Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.removed`` set to ``True``.

        Raises:
            ValueError: If ``userId`` is missing or the caller tries to remove
                themselves.
            PermissionError: If the caller is not an org admin.
        """
        # Require interactive login before any destructive membership change.
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))
        self._require_org_admin(org_id)

        target_user_id = args.get('userId')
        if not target_user_id:
            raise ValueError('userId is required')

        # Prevent self-removal which could inadvertently lock out the last admin.
        if target_user_id == self._account_info.userId:
            raise ValueError('You cannot remove yourself from the organization')

        # Remove the member from the org in the backend.
        await account.remove_org_member(org_id=org_id, user_id=target_user_id)

        # Notify the removed user; their subsequent commands will be rejected by
        # permission checks because they are no longer a member.
        self._push(target_user_id)
        return self.build_response(request, body={'removed': True})

    # =========================================================================
    # RREXT_ACCOUNT_TEAMS  — team management
    # =========================================================================

    async def on_rrext_account_teams(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_teams`` DAP command.

        Dispatches to one of seven subcommands:

        - ``list``          — list teams in the org
        - ``create``        — create a new team (requires Zitadel auth + org.admin)
        - ``delete``        — delete a team (requires Zitadel auth + org.admin)
        - ``get``           — get team details (requires team membership)
        - ``add_member``    — add a user to a team (requires Zitadel auth + team.admin)
        - ``update_member`` — update a team member's permissions (requires Zitadel auth + team.admin)
        - ``remove_member`` — remove a user from a team (requires Zitadel auth + team.admin)

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.subcommand``.

        Returns:
            Dict[str, Any]: DAP response from the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')

        if subcommand == 'list':
            return await self._teams_list(request, args)
        elif subcommand == 'create':
            return await self._teams_create(request, args)
        elif subcommand == 'delete':
            return await self._teams_delete(request, args)
        elif subcommand == 'get':
            return await self._teams_get(request, args)
        elif subcommand == 'add_member':
            return await self._teams_add_member(request, args)
        elif subcommand == 'update_member':
            return await self._teams_update_member(request, args)
        elif subcommand == 'remove_member':
            return await self._teams_remove_member(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _teams_list(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """List all teams in the user's organization.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.teams`` list.
        """
        # Resolve access to the org (defaults to first org if not specified).
        org_id = self._require_org(args.get('orgId'))
        teams = await account.list_teams(org_id)
        return self.build_response(request, body={'teams': teams})

    async def _teams_create(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new team. Requires Zitadel auth and org.admin.

        After creation the creator is automatically added as a team admin with
        the full permission set so they can immediately manage the team.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``name``.
                Optional: ``orgId``, ``color``.

        Returns:
            Dict[str, Any]: DAP response with the new team record as the body.

        Raises:
            ValueError: If ``name`` is missing.
            PermissionError: If the caller is not an org admin.
        """
        # Interactive login required to create a team.
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))
        self._require_org_admin(org_id)

        name = args.get('name')
        if not name:
            raise ValueError('name is required')
        color = args.get('color')

        # Create the team record in the backend.
        team = await account.create_team(org_id=org_id, name=name, color=color)

        # Auto-add the creator as team admin so they can manage the team immediately
        await account.add_team_member(
            team_id=team['id'],
            user_id=self._account_info.userId,
            permissions=['team.admin', 'read', 'write', 'execute', 'task.control', 'task.data', 'task.monitor', 'task.debug', 'task.store'],
        )

        # Push an update so the creator's session reflects the new team membership.
        self._push(self._account_info.userId)
        return self.build_response(request, body=team)

    async def _teams_delete(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a team. Requires Zitadel auth and org.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``teamId``.
                Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.deleted`` set to ``True``.

        Raises:
            ValueError: If ``teamId`` is missing.
            PermissionError: If the caller is not an org admin.
        """
        self.require_zitadel_auth()
        team_id = args.get('teamId')
        if not team_id:
            raise ValueError('teamId is required')

        # Verify org admin access for the org that owns this team
        org_id = self._require_org(args.get('orgId'))
        self._require_org_admin(org_id)

        # Delete the team; all associated members lose the team from their session.
        await account.delete_team(team_id)

        # Push an account update to the caller so their session no longer includes
        # the now-deleted team.
        self._push(self._account_info.userId)
        return self.build_response(request, body={'deleted': True})

    async def _teams_get(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Get team details including member list.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``teamId``.

        Returns:
            Dict[str, Any]: DAP response with the full team record (including
                member list) as the body.

        Raises:
            ValueError: If ``teamId`` is missing.
            PermissionError: If the caller is not a team admin.
        """
        team_id = args.get('teamId')
        if not team_id:
            raise ValueError('teamId is required')

        # Verify team membership — only team admins (or org admins) may
        # retrieve the full team record including its member list.
        # Verify team membership
        self._require_team_admin(team_id)
        team = await account.get_team(team_id)
        return self.build_response(request, body=team)

    async def _teams_add_member(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Add a user to a team. Requires Zitadel auth and team.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``teamId``
                and ``userId``.  Optional ``permissions`` (defaults to ``[]``).

        Returns:
            Dict[str, Any]: DAP response with the new team-membership record.

        Raises:
            ValueError: If ``teamId`` or ``userId`` is missing.
            PermissionError: If the caller does not hold team.admin.
        """
        self.require_zitadel_auth()
        team_id = args.get('teamId')
        target_user_id = args.get('userId')
        permissions = args.get('permissions', [])
        if not team_id or not target_user_id:
            raise ValueError('teamId and userId are required')

        # Ensure the caller is authorised to add members to this team.
        self._require_team_admin(team_id)
        result = await account.add_team_member(team_id=team_id, user_id=target_user_id, permissions=permissions)

        # Notify the newly added user so their session reflects the new membership.
        self._push(target_user_id)
        return self.build_response(request, body=result)

    async def _teams_update_member(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Update a team member's permissions. Requires Zitadel auth and team.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``teamId``
                and ``userId``.  Optional ``permissions`` (defaults to ``[]``).

        Returns:
            Dict[str, Any]: DAP response with the updated team-membership record.

        Raises:
            ValueError: If ``teamId`` or ``userId`` is missing.
            PermissionError: If the caller does not hold team.admin.
        """
        self.require_zitadel_auth()
        team_id = args.get('teamId')
        target_user_id = args.get('userId')
        permissions = args.get('permissions', [])
        if not team_id or not target_user_id:
            raise ValueError('teamId and userId are required')

        # Verify the caller can manage this team before changing permissions.
        self._require_team_admin(team_id)
        result = await account.update_team_member(team_id=team_id, user_id=target_user_id, permissions=permissions)

        # Push an update so the affected user sees their revised permissions immediately.
        self._push(target_user_id)
        return self.build_response(request, body=result)

    async def _teams_remove_member(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """Remove a user from a team. Requires Zitadel auth and team.admin.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``teamId``
                and ``userId``.

        Returns:
            Dict[str, Any]: DAP response with ``body.removed`` set to ``True``.

        Raises:
            ValueError: If ``teamId`` or ``userId`` is missing.
            PermissionError: If the caller does not hold team.admin.
        """
        self.require_zitadel_auth()
        team_id = args.get('teamId')
        target_user_id = args.get('userId')
        if not team_id or not target_user_id:
            raise ValueError('teamId and userId are required')

        # Verify admin rights before removing the member.
        self._require_team_admin(team_id)
        await account.remove_team_member(team_id=team_id, user_id=target_user_id)

        # Notify the removed user so their session drops the team immediately.
        self._push(target_user_id)
        return self.build_response(request, body={'removed': True})

    # =========================================================================
    # RREXT_ACCOUNT_BILLING  — per-app Stripe subscription management
    # =========================================================================

    async def on_rrext_account_billing(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle the ``rrext_account_billing`` DAP command.

        Dispatches to one of five subcommands:

        - ``prices``   — return active plans for a Stripe product (no auth required)
        - ``get``      — return per-app subscription details for an org
        - ``checkout`` — create a Stripe subscription and return the client_secret
                         for Stripe Elements (requires Zitadel auth)
        - ``portal``   — return a Stripe Billing Portal URL (requires Zitadel auth)
        - ``cancel``   — schedule a subscription for cancellation at period end
                         (requires Zitadel auth)

        Args:
            request (Dict[str, Any]): DAP request with ``arguments.subcommand``.

        Returns:
            Dict[str, Any]: DAP response from the selected subcommand.

        Raises:
            ValueError: If ``subcommand`` is missing or unrecognised.
        """
        args = request.get('arguments', {})
        subcommand = args.get('subcommand', '')
        debug(f'[cmd_account.on_rrext_account_billing] subcommand={subcommand!r}')

        if subcommand == 'prices':
            return await self._billing_prices(request, args)
        elif subcommand == 'get':
            return await self._billing_get(request, args)
        elif subcommand == 'checkout':
            return await self._billing_checkout(request, args)
        elif subcommand == 'portal':
            return await self._billing_portal(request, args)
        elif subcommand == 'cancel':
            return await self._billing_cancel(request, args)
        else:
            raise ValueError(f'Unknown subcommand: {subcommand}')

    async def _billing_prices(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Return the active subscription plans for a Stripe product.

        Calls ``stripe.Price.list(product=productId, active=True)`` and returns
        the results formatted for the frontend plan picker.  No authentication is
        required — pricing is public information.

        Plans are sorted month-first, year-second.  The ``amount`` field is
        formatted as a human-readable string (e.g. "$50 / mo").

        Args:
            request (Dict[str, Any]): DAP request.
            args    (Dict[str, Any]): Must contain ``productId`` (prod_* string).

        Returns:
            Dict with ``plans`` list, each entry containing:
            priceId, label, interval, amount.

        Raises:
            ValueError: If ``productId`` is missing.
        """
        from ai.account.auth.billing_service import StripeClient

        product_id = args.get('productId', '').strip()
        debug(f'[cmd_account._billing_prices] product_id={product_id!r}')
        if not product_id:
            raise ValueError('productId is required')

        # Initialise Stripe client (sets stripe.api_key from environment)
        StripeClient()

        import stripe as _stripe

        # Fetch all active prices for the product; expand recurring details
        price_list = _stripe.Price.list(product=product_id, active=True, limit=10)

        def _format_amount(unit_amount: int, currency: str) -> str:
            """Format a Stripe unit_amount (cents) into a display string."""
            # unit_amount is in the smallest currency unit (cents for USD)
            major = unit_amount / 100
            symbol = '$' if currency.upper() == 'USD' else currency.upper() + ' '
            return f'{symbol}{major:,.0f}'

        def _interval_label(interval: str) -> str:
            return 'Monthly' if interval == 'month' else 'Annual'

        def _interval_suffix(interval: str) -> str:
            return 'mo' if interval == 'month' else 'yr'

        # Build plan dicts; skip prices without a recurring interval (one-time)
        plans = []
        for price in price_list.data:
            recurring = getattr(price, 'recurring', None)
            if not recurring:
                continue
            interval = recurring.get('interval', '')
            unit_amount = price.unit_amount or 0
            currency = price.currency or 'usd'
            amount_str = f'{_format_amount(unit_amount, currency)} / {_interval_suffix(interval)}'
            label = price.nickname or _interval_label(interval)
            plans.append(
                {
                    'priceId': price.id,
                    'label': label,
                    'interval': interval,
                    'amount': amount_str,
                }
            )

        # Sort month before year so the picker displays monthly first
        interval_order = {'month': 0, 'year': 1}
        plans.sort(key=lambda p: interval_order.get(p['interval'], 99))
        debug(f'[cmd_account._billing_prices] returning {len(plans)} plans')

        return self.build_response(request, body={'plans': plans})

    async def _billing_get(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Return the per-app subscription details for an organisation.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``subscriptions`` list in the body.
            Each entry contains: app_id, stripe_subscription_id, stripe_price_id,
            status, current_period_end, cancel_at_period_end.
        """
        from ai.account.auth.billing_service import BillingRepository

        # Resolve and validate access to the org
        org_id = self._require_org(args.get('orgId'))
        debug(f'[cmd_account._billing_get] org_id={org_id}')

        # Query the subscription details for this org from the DB
        subscriptions = await BillingRepository().get_subscription_details(org_id)
        debug(f'[cmd_account._billing_get] returning {len(subscriptions)} subscriptions')
        return self.build_response(
            request,
            body={
                'orgId': org_id,
                'subscriptions': subscriptions,
            },
        )

    async def _billing_checkout(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create a Stripe subscription and return the Stripe Elements client_secret.

        Creates or reuses the org's Stripe customer record, then creates a
        subscription with ``payment_behavior='default_incomplete'`` so the
        browser can confirm payment via ``stripe.confirmPayment()``.

        Requires Zitadel auth.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``appId`` and
                ``priceId``.  Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``client_secret`` and
                ``subscription_id`` in the body.

        Raises:
            ValueError: If ``appId`` or ``priceId`` are missing.
        """
        from ai.account.auth.billing_service import StripeClient

        # Interactive login required before creating a payment subscription
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))

        # Validate required arguments
        app_id = args.get('appId', '')
        price_id = args.get('priceId', '')
        debug(f'[cmd_account._billing_checkout] org_id={org_id} app_id={app_id!r} price_id={price_id!r}')
        if not app_id:
            raise ValueError('appId is required')
        if not price_id:
            raise ValueError('priceId is required')

        # Retrieve the authenticated user's email for Stripe customer creation
        email = self._account_info.email or ''

        stripe = StripeClient()

        # ── Step 1: Get or create the Stripe customer for this org ───────────
        customer_id = await stripe.get_or_create_customer(org_id, email)
        debug(f'[cmd_account._billing_checkout] customer_id={customer_id}')

        # ── Step 2: Create the incomplete subscription ────────────────────────
        result = await stripe.create_subscription(customer_id, price_id, org_id, app_id)
        debug(f'[cmd_account._billing_checkout] done subscription_id={result["subscription_id"]}')

        return self.build_response(
            request,
            body={
                'client_secret': result['client_secret'],
                'subscription_id': result['subscription_id'],
            },
        )

    async def _billing_portal(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create a Stripe Billing Portal session and return the URL.

        Requires Zitadel auth.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Optional ``orgId``.
                Optional ``returnUrl`` — defaults to ``RR_FRONTEND_ORIGIN``.

        Returns:
            Dict[str, Any]: DAP response with ``portal_url`` in the body.

        Raises:
            ValueError: If no Stripe customer record exists for this org.
        """
        from ai.account.auth.billing_service import BillingRepository, StripeClient

        # Interactive login required before accessing billing management
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))
        debug(f'[cmd_account._billing_portal] org_id={org_id}')

        # Retrieve the existing Stripe customer — portal requires a prior subscription
        customer_row = await BillingRepository().get_customer_by_org(org_id)
        if not customer_row:
            debug(f'[cmd_account._billing_portal] no customer record for org_id={org_id}')
            raise ValueError('No billing account found for this organization')

        # Return URL is always supplied by the caller (window.location.origin in the browser)
        return_url = args.get('returnUrl') or '/'

        portal_url = await StripeClient().create_portal_session(
            customer_row['stripe_customer_id'],
            return_url,
        )
        debug(f'[cmd_account._billing_portal] portal_url={portal_url[:60]}...')
        return self.build_response(request, body={'portal_url': portal_url})

    async def _billing_cancel(self, request: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        """
        Schedule an app subscription for cancellation at the end of the period.

        The user retains access until the current billing period ends.  Stripe
        fires ``customer.subscription.updated`` immediately, which the webhook
        handler picks up to set ``cancel_at_period_end=True`` in the DB.

        Requires Zitadel auth.

        Args:
            request (Dict[str, Any]): Original DAP request.
            args (Dict[str, Any]): Parsed arguments.  Must contain ``appId``.
                Optional ``orgId``.

        Returns:
            Dict[str, Any]: DAP response with ``canceled: true`` in the body.

        Raises:
            ValueError: If ``appId`` is missing or no subscription exists for
                this org/app combination.
        """
        from ai.account.auth.billing_service import BillingRepository, StripeClient

        # Interactive login required before cancelling a subscription
        self.require_zitadel_auth()
        org_id = self._require_org(args.get('orgId'))

        app_id = args.get('appId', '')
        debug(f'[cmd_account._billing_cancel] org_id={org_id} app_id={app_id!r}')
        if not app_id:
            raise ValueError('appId is required')

        # Load the subscription row to get the Stripe subscription ID
        details = await BillingRepository().get_subscription_details(org_id)
        sub = next((s for s in details if s['app_id'] == app_id), None)
        if not sub:
            debug(f'[cmd_account._billing_cancel] no subscription found for app_id={app_id!r}')
            raise ValueError(f'No active subscription found for app {app_id!r}')

        debug(f'[cmd_account._billing_cancel] cancelling sub={sub["stripe_subscription_id"]}')
        # Tell Stripe to cancel at the end of the current period
        await StripeClient().cancel_at_period_end(sub['stripe_subscription_id'])
        debug('[cmd_account._billing_cancel] done')

        return self.build_response(request, body={'canceled': True})
