// =============================================================================
// MIT License
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
// EXPLORER CONNECT — IDENTITY (when cached connection state stops being valid)
// =============================================================================
//
// Discovered endpoints, their probes, their task tokens and the sessions bound
// to them all belong to ONE identity: this user, in this organization, with this
// development team. Anything else — a sign-out, another user, another
// organization — must find none of it, or the previous session's connections
// (and their tokens) bleed into the next.
//
// The fingerprint below is the whole rule. It deliberately contains no token,
// and deliberately excludes permission lists: a permission change updates
// hints, it does not invalidate state.
//
// Forgetting is not enough on its own. The server keeps a caller's OWN runs
// visible after an organization switch (owner, not team, decides who sees a
// user-owned run) and hands back their tokens, so the next discovery would
// list them again. Discovery therefore keeps a run only when its team is one
// of the teams the signed-in organization lists for the caller
// (`runInIdentityOrganization`); every run carries one (a dev run its
// development team, a personal deploy its billing team, a team deploy its
// team).
// =============================================================================

import { isPlainObject } from '../checks';
import type { IExplorerIdentity } from '../types';

/** The permission a caller needs to invoke a node tool (cmd_data: get_task(request, 'task.data')). */
export const TOOL_CALL_PERMISSION = 'task.data';

/**
 * Reduce an identity to the string that decides whether cached state is still
 * valid.
 *
 * @param identity - Who is signed in, or null when nobody is.
 * @returns The fingerprint, or null when nobody is signed in.
 */
export function identityFingerprint(identity: IExplorerIdentity | null): string | null {
	if (identity === null) return null;
	return `${identity.userId}|${identity.orgId}|${identity.devTeam}`;
}

/**
 * Read an identity out of the shell's ConnectResult (or anything shaped like
 * it). Duck-typed so this module imports nothing from the SDK, and tolerant
 * because the object arrives from the network.
 *
 * @param value - A ConnectResult, or null/undefined when signed out.
 * @returns The identity, or null when there is no usable user id.
 */
export function identityFromConnectResult(value: unknown): IExplorerIdentity | null {
	if (!isPlainObject(value) || typeof value.userId !== 'string' || value.userId === '') return null;
	const org = isPlainObject(value.organization) ? value.organization : null;
	const identity: IExplorerIdentity = {
		userId: value.userId,
		orgId: org !== null && typeof org.id === 'string' ? org.id : '',
		devTeam: typeof value.devTeam === 'string' ? value.devTeam : '',
	};
	if (org !== null) {
		if (Array.isArray(org.permissions)) identity.orgPermissions = org.permissions.filter((p): p is string => typeof p === 'string');
		if (Array.isArray(org.teams)) {
			const teams: Record<string, readonly string[]> = {};
			for (const team of org.teams) {
				if (!isPlainObject(team) || typeof team.id !== 'string') continue;
				teams[team.id] = Array.isArray(team.permissions) ? team.permissions.filter((p): p is string => typeof p === 'string') : [];
			}
			identity.teamPermissions = teams;
		}
	}
	return identity;
}

/**
 * Whether a run belongs to the organization the identity is signed in to, as
 * far as the identity can tell: its team is one of the teams that organization
 * lists for the caller. This one is a FILTER, not a hint: a run it rejects is
 * not listed at all, so its token never reaches the store.
 *
 * - no identity, or one that carries no team list (no organization data):
 *   true, nothing can be told;
 * - a run that names no team (an older server): true;
 * - otherwise: whether the run's team is in the list.
 *
 * @param identity - Who is signed in.
 * @param teamId - The run's team id ('' when the row names none).
 * @returns False only when the run's team is known not to be the organization's.
 */
export function runInIdentityOrganization(identity: IExplorerIdentity | null, teamId: string): boolean {
	if (identity === null || identity.teamPermissions === undefined || teamId === '') return true;
	return Object.prototype.hasOwnProperty.call(identity.teamPermissions, teamId);
}

/**
 * Whether the identity can invoke tools on a run, as far as the identity can
 * tell. A HINT: the server decides, and this only labels a failed probe.
 *
 * - the caller's own user-owned run: yes;
 * - a team run the identity has team permissions for: whether it lists
 *   `task.data` (team or organization level);
 * - anything else (an unknown team, no permission data): undefined — unknown.
 *
 * @param identity - Who is signed in.
 * @param ownerKind - 'user' or 'team'.
 * @param ownerId - The run's owner id.
 * @returns true / false when the identity can tell, undefined when it cannot.
 */
export function identityCanCallTools(identity: IExplorerIdentity | null, ownerKind: string, ownerId: string): boolean | undefined {
	if (identity === null) return undefined;
	if (ownerKind === 'user') return ownerId === identity.userId ? true : undefined;
	const team = identity.teamPermissions?.[ownerId];
	if (team === undefined) return undefined;
	if (team.includes(TOOL_CALL_PERMISSION) || identity.orgPermissions?.includes(TOOL_CALL_PERMISSION)) return true;
	return false;
}
