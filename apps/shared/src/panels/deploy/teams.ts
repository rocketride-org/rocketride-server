// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// TEAM RESOLUTION — the ONE implementation of the deploy surfaces' team rules
// =============================================================================
//
// Both hosts resolve the caller's team roster, display names, and wire
// addressing identically (rocket-ui's useDeployments and the VS Code pipeline
// page's deploy layer used to carry line-for-line copies — this module is the
// single home). The rules mirror the server resolver:
//
// - org.admin (and sys.admin) implies the FULL team permission set; per-team
//   rows only carry explicit task.* grants for regular members.
// - Rosterless identities (the OSS single-team server) derive refs from the
//   deployment rows with control assumed — the server enforces the real
//   permission on every call.
// - Personal (`user~`) owner keys never render raw and are addressed as
//   '@me' on the wire (the server never accepts raw owner keys).
// =============================================================================

import type { DeployTeamRef } from './types';

/** The identity facts team resolution reads — STRUCTURAL, so both the SDK's
 *  ConnectResult and a mirrored account snapshot satisfy it. */
export interface DeployIdentityLike {
	userId?: string;
	sysPermissions?: string[];
	organization?: {
		permissions?: string[];
		teams?: Array<{ id?: string; name?: string; permissions?: string[] }>;
	} | null;
}

/**
 * Resolves the caller's team roster (names + control rights) from the
 * authenticated identity.
 *
 * @param info - The authenticated identity (null pre-auth).
 * @param deployments - Deployment rows used as the rosterless fallback.
 * @returns Team refs with resolved display names and control rights.
 */
export function resolveDeployTeams(info: DeployIdentityLike | null | undefined, deployments: Array<{ teamId?: string }>): DeployTeamRef[] {
	const org = info?.organization;

	// The personal (@me) target — every authenticated user can point their
	// own space (the server applies no team permission to it; the @me PUBLISH
	// stamps the dev team or refuses). Listed first: it exists even for a
	// user with zero team memberships.
	const me: DeployTeamRef[] = info?.userId ? [{ id: '@me', name: 'Me', canControl: true }] : [];

	// Admin expansion — org.admin / sys.admin controls every team.
	const isAdmin = (org?.permissions ?? []).includes('org.admin') || (info?.sysPermissions ?? []).includes('sys.admin');

	// Prefer the identity's team roster when one exists.
	const orgTeams = org?.teams;
	if (Array.isArray(orgTeams) && orgTeams.length > 0) {
		return [...me, ...orgTeams.filter((t) => t.id).map((t) => ({ id: t.id as string, name: t.name || (t.id as string), canControl: isAdmin || (t.permissions ?? []).includes('task.control') }))];
	}

	// OSS / rosterless identity — derive refs from the deployment rows so the
	// surfaces still render; the server enforces real permissions. Personal
	// (user~) rows never become roster targets — '@me' covers the caller's
	// own space and foreign spaces are not addressable.
	const seen = new Map<string, DeployTeamRef>();
	for (const dep of deployments) {
		if (dep.teamId && !dep.teamId.startsWith('user~') && !seen.has(dep.teamId)) {
			seen.set(dep.teamId, { id: dep.teamId, name: dep.teamId, canControl: true });
		}
	}
	return [...me, ...seen.values()];
}

/**
 * Resolves a team id to its display name, falling back to the id. Personal
 * (`user~`) owner keys render as "Me" for the caller's own space and
 * "Personal" for another user's (admin visibility) — the raw guid never
 * reaches a label.
 *
 * @param teams - The resolved team refs.
 * @param teamId - The team id (or owner key) to resolve.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The display name, or the id when unknown.
 */
export function teamNameOf(teams: DeployTeamRef[], teamId: string, ownUserId = ''): string {
	if (teamId.startsWith('user~')) {
		return ownUserId && teamId === `user~${ownUserId}` ? 'Me' : 'Personal';
	}
	return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/**
 * Translates a row's owner key into the ADDRESSABLE team ref for API calls:
 * the caller's own `user~{uid}` row is addressed as `'@me'` (the server
 * never accepts raw owner keys); everything else passes through.
 *
 * @param teamId - The row's team id / owner key.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The teamId to put on the wire.
 */
export function wireTeamIdOf(teamId: string, ownUserId: string): string {
	return ownUserId && teamId === `user~${ownUserId}` ? '@me' : teamId;
}
