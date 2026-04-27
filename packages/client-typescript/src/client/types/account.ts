/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Account type definitions for the RocketRide TypeScript SDK.
 *
 * Data shapes for user profiles, API keys, organizations, teams, and members.
 * These mirror the server's DAP response shapes without importing any
 * platform-specific modules.
 */

// =============================================================================
// API KEYS
// =============================================================================

/** A single API key record returned from the server. */
export interface ApiKeyRecord {
	/** Unique identifier for the key. */
	id: string;

	/** Human-readable label given to the key at creation time. */
	name: string;

	/** The team this key is scoped to. */
	teamId: string;

	/** Display name of the team, or null if unavailable. */
	teamName: string | null;

	/** Array of permission strings granted to this key. */
	permissions: string[];

	/** ISO timestamp of when the key was created, or null. */
	createdAt: string | null;

	/** ISO timestamp of when the key expires, or null for no expiry. */
	expiresAt: string | null;

	/** ISO timestamp of when the key was last used, or null if never used. */
	lastUsedAt: string | null;

	/** ISO timestamp of when the key was revoked, or null if still active. */
	revokedAt: string | null;

	/** Whether the key is currently active (not expired and not revoked). */
	active: boolean;
}

// =============================================================================
// ORGANIZATION
// =============================================================================

/** Summary information about the current user's organization. */
export interface OrgDetail {
	/** Unique identifier for the organization. */
	id: string;

	/** Display name of the organization. */
	name: string;

	/** The billing / feature plan the organization is on. */
	plan: string;

	/** Total number of members in the organization. */
	memberCount: number;

	/** Total number of teams within the organization. */
	teamCount: number;
}

// =============================================================================
// MEMBERS
// =============================================================================

/** A single organization member record returned from the server. */
export interface MemberRecord {
	/** Unique identifier of the user. */
	userId: string;

	/** The user's display name. */
	displayName: string;

	/** The user's email address. */
	email: string;

	/** The user's organization-level role (e.g. "admin" or "member"). */
	role: string;

	/** Membership status (e.g. "active" or "pending"). */
	status: string;
}

// =============================================================================
// TEAMS
// =============================================================================

/** Summary of a team, used in the teams list view. */
export interface TeamRecord {
	/** Unique identifier for the team. */
	id: string;

	/** Display name of the team. */
	name: string;

	/** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
	color: string | null;

	/** Number of members currently in the team. */
	memberCount: number;
}

/** Full detail for a single team including its member list. */
export interface TeamDetail {
	/** Unique identifier for the team. */
	id: string;

	/** Display name of the team. */
	name: string;

	/** Optional brand color as a CSS hex string, or null to use the generated avatar color. */
	color: string | null;

	/** Full list of members belonging to this team. */
	members: TeamMemberRecord[];
}

/** A member record scoped to a specific team, including that team's permissions. */
export interface TeamMemberRecord {
	/** Unique identifier of the user. */
	userId: string;

	/** The user's display name. */
	displayName: string;

	/** The user's email address. */
	email: string;

	/** Array of permission strings this user holds within the team. */
	permissions: string[];
}

// =============================================================================
// NAVIGATION
// =============================================================================

/**
 * Union type for the five navigable sections within AccountView.
 * Controls which tab panel is active and which data is fetched.
 */
export type AccountSection = 'profile' | 'api-keys' | 'organization' | 'teams' | 'members';

// =============================================================================
// PROFILE UPDATE
// =============================================================================

/**
 * The set of mutable profile fields submitted when saving profile edits.
 * All fields are strings; an empty string means no change.
 */
export interface ProfileUpdate {
	/** Display name (nickname). */
	displayName: string;

	/** Preferred login / username. */
	preferredUsername: string;

	/** First / given name. */
	givenName: string;

	/** Last / family name. */
	familyName: string;

	/** Primary email address. */
	email: string;

	/** Phone number in E.164 format. */
	phoneNumber: string;

	/** Locale / language preference. */
	locale: string;
}

// =============================================================================
// PARAM TYPES
// =============================================================================

/** Parameters for creating a new API key. */
export interface CreateKeyParams {
	/** Human-readable label for the key. */
	name: string;

	/** The team this key is scoped to. */
	teamId: string;

	/** Array of permission strings to grant to this key. */
	permissions: string[];

	/** Optional ISO timestamp for key expiration. Omit for no expiry. */
	expiresAt?: string;
}

/** Parameters for inviting a new member to an organization. */
export interface InviteMemberParams {
	/** Email address of the person to invite. */
	email: string;

	/** First / given name of the invitee. */
	givenName: string;

	/** Last / family name of the invitee. */
	familyName: string;

	/** Organization-level role to assign (e.g. "admin" or "member"). */
	role: string;
}

/** Parameters for adding or updating a team member. */
export interface TeamMemberParams {
	/** The team to add the member to or update within. */
	teamId: string;

	/** The user ID of the member. */
	userId: string;

	/** Permissions to grant within the team. */
	permissions: string[];
}
