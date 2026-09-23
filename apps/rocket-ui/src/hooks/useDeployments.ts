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
// USE DEPLOYMENTS — team deployments + team refs for the deploy surfaces
// =============================================================================
//
// One hook feeding every deploy surface in the app: the sidebar DEPLOYMENTS
// tree, the file view's DEPLOY lifecycle page, and the file-less deployment
// tab. Fetches client.deploy.list() on connect and re-fetches on the
// server's apaevt_deploy invalidation push (any deployment mutation in the
// org), and resolves team display names + per-team control rights from the
// authenticated identity.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShellConnection, useAuthUser, ConnectionManager } from 'shell';
import type { Deployment } from 'shell';
import type { DeployTeamRef } from 'shared/components/deploy-panel';

/** Return shape of {@link useDeployments}. */
export interface UseDeploymentsResult {
	/** Every visible team deployment (list envelope rows, non-removed). */
	deployments: Deployment[];
	/** Teams visible to the caller, with resolved names + control rights. */
	teams: DeployTeamRef[];
	/** Resolve a team id to its display name (falls back to the id). */
	teamName: (teamId: string) => string;
	/** Force an immediate re-fetch (sidebar refresh button, post-mutation). */
	refresh: () => void;
}

/**
 * Fetch + poll the caller's team deployments and team roster.
 *
 * Team names and task.control rights come from the authenticated identity
 * (organization.teams). When the identity carries no team roster (the OSS
 * single-team server), names fall back to the team id and control is
 * assumed — the server enforces the real permission on every call.
 *
 * @returns Deployments, team refs, a name resolver, and a manual refresh.
 */
export function useDeployments(): UseDeploymentsResult {
	const { client, isConnected } = useShellConnection();
	const authUser = useAuthUser();

	const [deployments, setDeployments] = useState<Deployment[]>([]);
	const [refreshTick, setRefreshTick] = useState(0);

	// --- Team roster from the identity ---------------------------------------

	const teams = useMemo<DeployTeamRef[]>(() => {
		const org = authUser?.organization as
			| {
					permissions?: string[];
					teams?: Array<{ id?: string; name?: string; permissions?: string[] }>;
			  }
			| undefined;
		// The personal (@me) target — every authenticated user can point
		// their own space (no team permission applies; the @me PUBLISH
		// stamps the dev team or refuses). Listed first: it exists even
		// for a user with zero team memberships.
		const me: DeployTeamRef[] = authUser?.userId ? [{ id: '@me', name: 'Me', canControl: true }] : [];
		// Mirror the server resolver's documented expansion: org.admin (and
		// sys.admin) implies the FULL team permission set — per-team rows
		// only carry explicit task.* grants for regular members.
		const isAdmin = (org?.permissions ?? []).includes('org.admin') || ((authUser as { sysPermissions?: string[] } | null)?.sysPermissions ?? []).includes('sys.admin');
		const orgTeams = org?.teams;
		if (Array.isArray(orgTeams) && orgTeams.length > 0) {
			return [
				...me,
				...orgTeams
					.filter((t) => t.id)
					.map((t) => ({
						id: t.id as string,
						name: t.name || (t.id as string),
						canControl: isAdmin || (t.permissions ?? []).includes('task.control'),
					})),
			];
		}
		// OSS / rosterless identity: derive refs from the deployment rows so
		// the tree still renders; the server enforces real permissions.
		// Personal (user~) rows never become roster targets — '@me' covers
		// the caller's own space; foreign spaces are not addressable.
		const seen = new Map<string, DeployTeamRef>();
		for (const dep of deployments) {
			if (dep.teamId && !dep.teamId.startsWith('user~') && !seen.has(dep.teamId))
				seen.set(dep.teamId, {
					id: dep.teamId,
					name: dep.teamId,
					canControl: true,
				});
		}
		return [...me, ...seen.values()];
	}, [authUser, deployments]);

	const teamName = useCallback(
		(teamId: string): string => {
			// Personal owner keys never render raw: the caller's own space is
			// "Me", another user's (admin visibility) is "Personal".
			if (teamId.startsWith('user~')) {
				return authUser?.userId && teamId === `user~${authUser.userId}` ? 'Me' : 'Personal';
			}
			return teams.find((t) => t.id === teamId)?.name ?? teamId;
		},
		[teams, authUser],
	);

	// --- Push-driven deployments list -----------------------------------------
	// Fetched on connect/refresh and re-fetched when the server pushes an
	// apaevt_deploy invalidation (any deployment mutation in the org) — the
	// event carries identity only; the fetch stays the source of truth. A
	// small jitter staggers the herd when one mutation reaches many clients.

	// Monotonic request counter: push-driven and manual fetches share no
	// coordination, so two can be in flight at once and the SLOWER one must
	// never overwrite the newer result (there is no poll left to repair it).
	const fetchSeq = useRef(0);

	// One fetch, shared by the subscription effect (initial + push-driven)
	// and the manual-refresh effect below. Identity changes only with the
	// connection, so neither effect churns on a refresh.
	const fetchOnce = useCallback(async (): Promise<void> => {
		if (!client || !isConnected) return;
		const mine = ++fetchSeq.current;
		try {
			const body = await client.deploy.list();
			// A slower earlier request must never overwrite a newer result.
			if (mine !== fetchSeq.current) return;
			setDeployments(body.rows ?? []);
		} catch (err) {
			// A transient list failure keeps the previous tree rather than
			// blanking the section on every hiccup.
			console.log('[useDeployments] list failed:', err);
		}
	}, [client, isConnected]);

	useEffect(() => {
		if (!client || !isConnected) {
			// Invalidate any in-flight response from the dropped connection
			// so it cannot shadow the first fetch after reconnect.
			fetchSeq.current++;
			setDeployments([]);
			return;
		}
		let jitterTimer: ReturnType<typeof setTimeout> | null = null;
		void fetchOnce();

		// The subscription lives for the CONNECTION, not per refresh — a
		// manual refresh must never tear the monitor down (invalidations
		// pushed during the re-register gap would be lost for good).
		client.addMonitor({ token: '*' }, ['deploy']).catch((err) => console.log('[useDeployments] deploy monitor failed:', err));
		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: any }) => {
			if (event?.event !== 'apaevt_deploy') return;
			if (jitterTimer) return; // A fetch is already pending — coalesce.
			jitterTimer = setTimeout(() => {
				jitterTimer = null;
				void fetchOnce();
			}, Math.random() * 500);
		});

		return () => {
			if (jitterTimer) clearTimeout(jitterTimer);
			unsub();
			client.removeMonitor({ token: '*' }, ['deploy']).catch(() => {});
		};
	}, [client, isConnected, fetchOnce]);

	// Manual refresh = refetch only; tick 0 is covered by the effect above.
	useEffect(() => {
		if (refreshTick === 0) return;
		void fetchOnce();
	}, [refreshTick, fetchOnce]);

	const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

	return { deployments, teams, teamName, refresh };
}
