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
 * Account API namespace for the RocketRide TypeScript SDK.
 *
 * Provides typed methods for managing the authenticated user's profile,
 * API keys, organization, members, and teams via DAP commands over the
 * existing WebSocket connection.
 */

import type { RocketRideClient } from './client.js';
import type { ConnectResult } from './types/client.js';
import type { OrgDetail, ApiKeyRecord, MemberRecord, TeamRecord, TeamDetail, ProfileUpdate, CreateKeyParams, InviteMemberParams, TeamMemberParams } from './types/account.js';

// =============================================================================
// ACCOUNT API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_account_*` DAP commands.
 *
 * Accessed via `client.account` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.dap} which handles envelope
 * unwrapping and error propagation.
 */
export class AccountApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// PROFILE
	// =========================================================================

	/**
	 * Fetches the current user's profile from the server.
	 *
	 * @returns The user's profile data.
	 */
	async getProfile(): Promise<ConnectResult> {
		return this.client.call<ConnectResult>('rrext_account_me', { subcommand: 'get' });
	}

	/**
	 * Persists updated profile fields.
	 *
	 * @param fields - The profile fields to update.
	 */
	async updateProfile(fields: ProfileUpdate): Promise<void> {
		await this.client.call('rrext_account_me', { subcommand: 'update', ...fields });
	}

	/**
	 * Sets the user's preferred default team.
	 *
	 * @param teamId - The team ID to set as default.
	 */
	async setDefaultTeam(teamId: string): Promise<void> {
		await this.client.call('rrext_account_me', { subcommand: 'set_default_team', teamId });
	}

	/**
	 * Permanently deletes the current user's account.
	 */
	async deleteAccount(): Promise<void> {
		await this.client.call('rrext_account_me', { subcommand: 'delete' });
	}

	// =========================================================================
	// ORGANIZATION
	// =========================================================================

	/**
	 * Fetches the organization detail for the given org.
	 *
	 * @param orgId - Organisation UUID. The server may infer the org if omitted.
	 * @returns The organization detail (id, name, plan, memberCount, teamCount).
	 */
	async getOrg(orgId?: string): Promise<OrgDetail> {
		return this.client.call<OrgDetail>('rrext_account_org', { subcommand: 'get', ...(orgId ? { orgId } : {}) });
	}

	/**
	 * Updates the organization name.
	 *
	 * @param orgId - Organisation UUID.
	 * @param name  - The new organization name.
	 */
	async updateOrgName(orgId: string, name: string): Promise<void> {
		await this.client.call('rrext_account_org', { subcommand: 'update', orgId, name });
	}

	// =========================================================================
	// API KEYS
	// =========================================================================

	/**
	 * Fetches the list of API keys for the current user.
	 *
	 * @returns Array of API key records.
	 */
	async listKeys(): Promise<ApiKeyRecord[]> {
		const body = await this.client.call('rrext_account_keys', { subcommand: 'list' });
		return body.keys ?? [];
	}

	/**
	 * Creates a new API key and returns the raw key string.
	 *
	 * @param params - Key creation parameters (name, teamId, permissions, expiresAt).
	 * @returns Object containing the raw key string.
	 */
	async createKey(params: CreateKeyParams): Promise<{ key: string }> {
		const body = await this.client.call('rrext_account_keys', { subcommand: 'create', ...params });
		return { key: body.key };
	}

	/**
	 * Revokes an API key by its ID.
	 *
	 * @param keyId - The key to revoke.
	 */
	async revokeKey(keyId: string): Promise<void> {
		await this.client.call('rrext_account_keys', { subcommand: 'revoke', keyId });
	}

	// =========================================================================
	// MEMBERS
	// =========================================================================

	/**
	 * Fetches the flat list of organization members.
	 *
	 * @param orgId - Organisation UUID.
	 * @returns Array of member records.
	 */
	async listMembers(orgId: string): Promise<MemberRecord[]> {
		const body = await this.client.call('rrext_account_members', { subcommand: 'list', orgId });
		return body.members ?? [];
	}

	/**
	 * Sends an invitation to a new organization member.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param params - Invitation parameters (email, givenName, familyName, role).
	 */
	async inviteMember(orgId: string, params: InviteMemberParams): Promise<void> {
		await this.client.call('rrext_account_members', { subcommand: 'invite', orgId, ...params });
	}

	/**
	 * Updates an organization member's role.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param userId - The member's user ID.
	 * @param role   - The new role string.
	 */
	async updateMemberRole(orgId: string, userId: string, role: string): Promise<void> {
		await this.client.call('rrext_account_members', { subcommand: 'update', orgId, userId, role });
	}

	/**
	 * Removes an organization member.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param userId - The member's user ID.
	 */
	async removeMember(orgId: string, userId: string): Promise<void> {
		await this.client.call('rrext_account_members', { subcommand: 'remove', orgId, userId });
	}

	// =========================================================================
	// TEAMS
	// =========================================================================

	/**
	 * Fetches the flat list of teams in the organization.
	 *
	 * @param orgId - Organisation UUID.
	 * @returns Array of team summary records.
	 */
	async listTeams(orgId: string): Promise<TeamRecord[]> {
		const body = await this.client.call('rrext_account_teams', { subcommand: 'list', orgId });
		return body.teams ?? [];
	}

	/**
	 * Fetches full detail (including member list) for a specific team.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param teamId - The team to load.
	 * @returns The team detail with nested members.
	 */
	async getTeamDetail(orgId: string, teamId: string): Promise<TeamDetail> {
		return this.client.call<TeamDetail>('rrext_account_teams', { subcommand: 'get', orgId, teamId });
	}

	/**
	 * Creates a new team.
	 *
	 * @param orgId - Organisation UUID.
	 * @param name  - The team name.
	 */
	async createTeam(orgId: string, name: string): Promise<void> {
		await this.client.call('rrext_account_teams', { subcommand: 'create', orgId, name });
	}

	/**
	 * Deletes a team.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param teamId - The team to delete.
	 */
	async deleteTeam(orgId: string, teamId: string): Promise<void> {
		await this.client.call('rrext_account_teams', { subcommand: 'delete', orgId, teamId });
	}

	/**
	 * Adds a member to a team with specified permissions.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param params - Parameters (teamId, userId, permissions).
	 */
	async addTeamMember(orgId: string, params: TeamMemberParams): Promise<void> {
		await this.client.call('rrext_account_teams', { subcommand: 'add_member', orgId, ...params });
	}

	/**
	 * Updates a team member's permissions.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param params - Parameters (teamId, userId, permissions).
	 */
	async updateTeamMemberPerms(orgId: string, params: TeamMemberParams): Promise<void> {
		await this.client.call('rrext_account_teams', { subcommand: 'update_member', orgId, ...params });
	}

	/**
	 * Removes a member from a team.
	 *
	 * @param orgId  - Organisation UUID.
	 * @param params - Parameters (teamId, userId).
	 */
	async removeTeamMember(orgId: string, params: { teamId: string; userId: string }): Promise<void> {
		await this.client.call('rrext_account_teams', { subcommand: 'remove_member', orgId, ...params });
	}
}
