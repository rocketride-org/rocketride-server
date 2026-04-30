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
Account API namespace for the RocketRide Python SDK.

Provides typed methods for managing the authenticated user's profile,
API keys, organization, members, and teams via DAP commands over the
existing WebSocket connection.

Usage:
    profile = await client.account.get_profile()
    await client.account.update_profile(displayName='New Name')
    keys = await client.account.list_keys()
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types.account import (
    AccountProfile,
    ApiKeyRecord,
    CreateKeyResult,
    MemberRecord,
    OrgDetail,
    TeamDetail,
    TeamRecord,
)

if TYPE_CHECKING:
    from .client import RocketRideClient


class AccountApi:
    """
    Account management namespace on RocketRideClient.

    Accessed via ``client.account`` -- not instantiated directly. All methods
    delegate to the parent client's ``call()`` method which handles envelope
    construction, sending, error detection, and tracing.
    """

    def __init__(self, client: RocketRideClient) -> None:
        """
        Bind this namespace to its parent client.

        Args:
            client: The RocketRideClient instance that owns this namespace.
        """
        self._client = client

    # =========================================================================
    # PROFILE
    # =========================================================================

    async def get_profile(self) -> AccountProfile:
        """
        Fetch the current user's profile from the server.

        Returns:
            The user's profile data.
        """
        return await self._client.call('rrext_account_me', subcommand='get')

    async def update_profile(self, **fields: str) -> None:
        """
        Persist updated profile fields.

        Args:
            **fields: Profile fields to update (displayName, givenName, etc.).
                All values are strings; an empty string means no change.
        """
        await self._client.call('rrext_account_me', subcommand='update', **fields)

    async def set_default_team(self, team_id: str) -> None:
        """
        Set the user's preferred default team.

        Args:
            team_id: The team ID to set as default.
        """
        await self._client.call('rrext_account_me', subcommand='set_default_team', teamId=team_id)

    async def delete_account(self) -> None:
        """Permanently delete the current user's account."""
        await self._client.call('rrext_account_me', subcommand='delete')

    # =========================================================================
    # ORGANIZATION
    # =========================================================================

    async def get_org(self, org_id: str) -> OrgDetail:
        """
        Fetch the organization detail for the given org.

        Args:
            org_id: Organisation UUID.

        Returns:
            The organization detail (id, name, plan, memberCount, teamCount).
        """
        return await self._client.call('rrext_account_org', subcommand='get', orgId=org_id)

    async def update_org_name(self, org_id: str, name: str) -> None:
        """
        Update the organization name.

        Args:
            org_id: Organisation UUID.
            name: The new organization name.
        """
        await self._client.call('rrext_account_org', subcommand='update', orgId=org_id, name=name)

    # =========================================================================
    # API KEYS
    # =========================================================================

    async def list_keys(self) -> list[ApiKeyRecord]:
        """
        Fetch the list of API keys for the current user.

        Returns:
            Array of API key records.
        """
        body = await self._client.call('rrext_account_keys', subcommand='list')
        return body.get('keys', [])

    async def create_key(
        self,
        *,
        name: str,
        team_id: str,
        permissions: list[str],
        expires_at: str | None = None,
    ) -> CreateKeyResult:
        """
        Create a new API key and return the raw key string.

        Args:
            name: Human-readable label for the key.
            team_id: The team this key is scoped to.
            permissions: Array of permission strings to grant to this key.
            expires_at: Optional ISO timestamp for key expiration. None means no expiry.

        Returns:
            Dict containing the raw key string under the ``key`` field.
        """
        # Build arguments with camelCase keys for the server
        kwargs: dict = {
            'subcommand': 'create',
            'name': name,
            'teamId': team_id,
            'permissions': permissions,
        }
        if expires_at is not None:
            kwargs['expiresAt'] = expires_at

        body = await self._client.call('rrext_account_keys', **kwargs)
        return {'key': body['key']}

    async def revoke_key(self, key_id: str) -> None:
        """
        Revoke an API key by its ID.

        Args:
            key_id: The key to revoke.
        """
        await self._client.call('rrext_account_keys', subcommand='revoke', keyId=key_id)

    # =========================================================================
    # MEMBERS
    # =========================================================================

    async def list_members(self, org_id: str) -> list[MemberRecord]:
        """
        Fetch the flat list of organization members.

        Args:
            org_id: Organisation UUID.

        Returns:
            Array of member records.
        """
        body = await self._client.call('rrext_account_members', subcommand='list', orgId=org_id)
        return body.get('members', [])

    async def invite_member(
        self,
        org_id: str,
        *,
        email: str,
        given_name: str,
        family_name: str,
        role: str,
    ) -> None:
        """
        Send an invitation to a new organization member.

        Args:
            org_id: Organisation UUID.
            email: Email address of the person to invite.
            given_name: First / given name of the invitee.
            family_name: Last / family name of the invitee.
            role: Organization-level role to assign (e.g. "admin" or "member").
        """
        await self._client.call(
            'rrext_account_members',
            subcommand='invite',
            orgId=org_id,
            email=email,
            givenName=given_name,
            familyName=family_name,
            role=role,
        )

    async def update_member_role(self, org_id: str, user_id: str, role: str) -> None:
        """
        Update an organization member's role.

        Args:
            org_id: Organisation UUID.
            user_id: The member's user ID.
            role: The new role string.
        """
        await self._client.call(
            'rrext_account_members',
            subcommand='update',
            orgId=org_id,
            userId=user_id,
            role=role,
        )

    async def remove_member(self, org_id: str, user_id: str) -> None:
        """
        Remove an organization member.

        Args:
            org_id: Organisation UUID.
            user_id: The member's user ID.
        """
        await self._client.call(
            'rrext_account_members',
            subcommand='remove',
            orgId=org_id,
            userId=user_id,
        )

    # =========================================================================
    # TEAMS
    # =========================================================================

    async def list_teams(self, org_id: str) -> list[TeamRecord]:
        """
        Fetch the flat list of teams in the organization.

        Args:
            org_id: Organisation UUID.

        Returns:
            Array of team summary records.
        """
        body = await self._client.call('rrext_account_teams', subcommand='list', orgId=org_id)
        return body.get('teams', [])

    async def get_team_detail(self, org_id: str, team_id: str) -> TeamDetail:
        """
        Fetch full detail (including member list) for a specific team.

        Args:
            org_id: Organisation UUID.
            team_id: The team to load.

        Returns:
            The team detail with nested members.
        """
        return await self._client.call(
            'rrext_account_teams',
            subcommand='get',
            orgId=org_id,
            teamId=team_id,
        )

    async def create_team(self, org_id: str, name: str) -> None:
        """
        Create a new team.

        Args:
            org_id: Organisation UUID.
            name: The team name.
        """
        await self._client.call('rrext_account_teams', subcommand='create', orgId=org_id, name=name)

    async def delete_team(self, org_id: str, team_id: str) -> None:
        """
        Delete a team.

        Args:
            org_id: Organisation UUID.
            team_id: The team to delete.
        """
        await self._client.call(
            'rrext_account_teams',
            subcommand='delete',
            orgId=org_id,
            teamId=team_id,
        )

    async def add_team_member(
        self,
        org_id: str,
        *,
        team_id: str,
        user_id: str,
        permissions: list[str],
    ) -> None:
        """
        Add a member to a team with specified permissions.

        Args:
            org_id: Organisation UUID.
            team_id: The team to add the member to.
            user_id: The user ID of the member.
            permissions: Permissions to grant within the team.
        """
        await self._client.call(
            'rrext_account_teams',
            subcommand='add_member',
            orgId=org_id,
            teamId=team_id,
            userId=user_id,
            permissions=permissions,
        )

    async def update_team_member_perms(
        self,
        org_id: str,
        *,
        team_id: str,
        user_id: str,
        permissions: list[str],
    ) -> None:
        """
        Update a team member's permissions.

        Args:
            org_id: Organisation UUID.
            team_id: The team containing the member.
            user_id: The user ID of the member.
            permissions: New permissions to set within the team.
        """
        await self._client.call(
            'rrext_account_teams',
            subcommand='update_member',
            orgId=org_id,
            teamId=team_id,
            userId=user_id,
            permissions=permissions,
        )

    async def remove_team_member(
        self,
        org_id: str,
        *,
        team_id: str,
        user_id: str,
    ) -> None:
        """
        Remove a member from a team.

        Args:
            org_id: Organisation UUID.
            team_id: The team to remove the member from.
            user_id: The user ID of the member.
        """
        await self._client.call(
            'rrext_account_teams',
            subcommand='remove_member',
            orgId=org_id,
            teamId=team_id,
            userId=user_id,
        )
