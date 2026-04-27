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
Account Type Definitions for the RocketRide Python SDK.

Data shapes for user profiles, API keys, organizations, teams, and members.
These mirror the server's DAP response shapes and the TypeScript SDK's
``types/account.ts`` definitions.

Types Defined:
    AccountProfile: The authenticated user's profile data.
    AccountOrganization: An organization entry nested inside AccountProfile.
    AccountOrgTeam: A team entry nested inside AccountOrganization.
    ApiKeyRecord: A single API key record returned from the server.
    OrgDetail: Summary information about an organization.
    MemberRecord: A single organization member record.
    TeamRecord: Summary of a team, used in the teams list view.
    TeamDetail: Full detail for a single team including its member list.
    TeamMemberRecord: A member record scoped to a specific team.
    ProfileUpdate: Mutable profile fields submitted when saving edits.
    CreateKeyParams: Parameters for creating a new API key.
    CreateKeyResult: Result containing the raw key string.
    InviteMemberParams: Parameters for inviting a new member.
    TeamMemberParams: Parameters for adding or updating a team member.
"""

from typing import TypedDict


# =============================================================================
# PROFILE
# =============================================================================


class AccountOrgTeam(TypedDict):
    """
    A team entry nested inside an AccountOrganization.

    Represents the user's membership within one team.

    Attributes:
        id: Unique identifier for the team.
        name: Display name of the team.
        permissions: Permissions the user holds within this team.
    """

    id: str
    name: str
    permissions: list[str]


class AccountOrganization(TypedDict, total=False):
    """
    An organization entry nested inside AccountProfile.

    Mirrors the shape returned by the server's ``organizations`` array.

    Attributes:
        id: Unique identifier for the organization.
        name: Display name of the organization.
        permissions: Permissions the user holds at the organization level.
        teams: Teams the user belongs to within this organization.
    """

    id: str
    name: str
    permissions: list[str]
    teams: list[AccountOrgTeam]


class AccountProfile(TypedDict, total=False):
    """
    The authenticated user's profile data returned by the account endpoint.

    Matches the ConnectResult identity fields but is SDK-agnostic -- callers
    that only need profile information can depend on this lighter type.

    Attributes:
        userId: Unique identifier of the user.
        displayName: The user's display name (nickname).
        givenName: The user's first / given name.
        familyName: The user's last / family name.
        preferredUsername: The user's preferred login name.
        email: Primary email address.
        emailVerified: Whether the email has been verified.
        phoneNumber: Primary phone number in E.164 format.
        phoneNumberVerified: Whether the phone number has been verified.
        locale: Locale / language preference (e.g. "en").
        defaultTeam: The ID of the user's default team context.
        organizations: Organizations the user belongs to.
    """

    userId: str
    displayName: str
    givenName: str
    familyName: str
    preferredUsername: str
    email: str
    emailVerified: bool
    phoneNumber: str
    phoneNumberVerified: bool
    locale: str
    defaultTeam: str
    organizations: list[AccountOrganization]


# =============================================================================
# API KEYS
# =============================================================================


class ApiKeyRecord(TypedDict, total=False):
    """
    A single API key record returned from the server.

    Attributes:
        id: Unique identifier for the key.
        name: Human-readable label given to the key at creation time.
        teamId: The team this key is scoped to.
        teamName: Display name of the team, or None if unavailable.
        permissions: Array of permission strings granted to this key.
        createdAt: ISO timestamp of when the key was created, or None.
        expiresAt: ISO timestamp of when the key expires, or None for no expiry.
        lastUsedAt: ISO timestamp of when the key was last used, or None.
        revokedAt: ISO timestamp of when the key was revoked, or None if active.
        active: Whether the key is currently active (not expired, not revoked).
    """

    id: str
    name: str
    teamId: str
    teamName: str | None
    permissions: list[str]
    createdAt: str | None
    expiresAt: str | None
    lastUsedAt: str | None
    revokedAt: str | None
    active: bool


# =============================================================================
# ORGANIZATION
# =============================================================================


class OrgDetail(TypedDict):
    """
    Summary information about the current user's organization.

    Attributes:
        id: Unique identifier for the organization.
        name: Display name of the organization.
        plan: The billing / feature plan the organization is on.
        memberCount: Total number of members in the organization.
        teamCount: Total number of teams within the organization.
    """

    id: str
    name: str
    plan: str
    memberCount: int
    teamCount: int


# =============================================================================
# MEMBERS
# =============================================================================


class MemberRecord(TypedDict):
    """
    A single organization member record returned from the server.

    Attributes:
        userId: Unique identifier of the user.
        displayName: The user's display name.
        email: The user's email address.
        role: The user's organization-level role (e.g. "admin" or "member").
        status: Membership status (e.g. "active" or "pending").
    """

    userId: str
    displayName: str
    email: str
    role: str
    status: str


# =============================================================================
# TEAMS
# =============================================================================


class TeamRecord(TypedDict):
    """
    Summary of a team, used in the teams list view.

    Attributes:
        id: Unique identifier for the team.
        name: Display name of the team.
        color: Optional brand color as a CSS hex string, or None.
        memberCount: Number of members currently in the team.
    """

    id: str
    name: str
    color: str | None
    memberCount: int


class TeamMemberRecord(TypedDict):
    """
    A member record scoped to a specific team, including that team's permissions.

    Attributes:
        userId: Unique identifier of the user.
        displayName: The user's display name.
        email: The user's email address.
        permissions: Permission strings this user holds within the team.
    """

    userId: str
    displayName: str
    email: str
    permissions: list[str]


class TeamDetail(TypedDict):
    """
    Full detail for a single team including its member list.

    Attributes:
        id: Unique identifier for the team.
        name: Display name of the team.
        color: Optional brand color as a CSS hex string, or None.
        members: Full list of members belonging to this team.
    """

    id: str
    name: str
    color: str | None
    members: list[TeamMemberRecord]


# =============================================================================
# PARAM TYPES
# =============================================================================


class ProfileUpdate(TypedDict):
    """
    The set of mutable profile fields submitted when saving profile edits.

    All fields are strings; an empty string means no change.

    Attributes:
        displayName: Display name (nickname).
        preferredUsername: Preferred login / username.
        givenName: First / given name.
        familyName: Last / family name.
        email: Primary email address.
        phoneNumber: Phone number in E.164 format.
        locale: Locale / language preference.
    """

    displayName: str
    preferredUsername: str
    givenName: str
    familyName: str
    email: str
    phoneNumber: str
    locale: str


class CreateKeyParams(TypedDict, total=False):
    """
    Parameters for creating a new API key.

    Attributes:
        name: Human-readable label for the key.
        teamId: The team this key is scoped to.
        permissions: Array of permission strings to grant to this key.
        expiresAt: Optional ISO timestamp for key expiration. Omit for no expiry.
    """

    name: str
    teamId: str
    permissions: list[str]
    expiresAt: str


CreateKeyResult = TypedDict('CreateKeyResult', {'key': str})
"""Result of creating a new API key, containing the raw key string."""


class InviteMemberParams(TypedDict):
    """
    Parameters for inviting a new member to an organization.

    Attributes:
        email: Email address of the person to invite.
        givenName: First / given name of the invitee.
        familyName: Last / family name of the invitee.
        role: Organization-level role to assign (e.g. "admin" or "member").
    """

    email: str
    givenName: str
    familyName: str
    role: str


class TeamMemberParams(TypedDict):
    """
    Parameters for adding or updating a team member.

    Attributes:
        teamId: The team to add the member to or update within.
        userId: The user ID of the member.
        permissions: Permissions to grant within the team.
    """

    teamId: str
    userId: str
    permissions: list[str]
