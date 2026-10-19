// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentProvider — thin shell wrapper around shared EnvironmentView.
 *
 * Owns all env fetching and auth wiring. Passes pure data and async
 * callbacks down to the host-agnostic EnvironmentView. Engine access is
 * the brokered `client.account.getEnv/setEnv` bus ops, so the component is
 * realm-agnostic (in-process at a framework root; bridged in a spoke).
 */

import React, { useState, useCallback } from 'react';
import { EnvironmentView } from '../modules/environment';
import type { EnvironmentSlotConfig, EnvironmentScope } from '../modules/environment';
import { useShellConnection } from '../connection/ConnectionContext';
import { useAuthUser } from '../hooks/useAuthUser';
import { ConnectionManager } from '../connection/connection';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Cloud-UI EnvironmentView wrapper.
 *
 * Fetches env data via the RocketRide client and delegates all rendering
 * to the shared EnvironmentView. Shell-UI always has a single connection,
 * so a single slot is passed; the slot's `isSaas` comes from the server's
 * capabilities so an OSS server gets the flat single-card layout instead
 * of org/team scope cards its account backend would reject.
 */
const EnvironmentProvider: React.FC = () => {
	const { isConnected } = useShellConnection();
	const authUser = useAuthUser();
	const isSaas = (authUser?.capabilities ?? []).includes('saas');

	// ── Error state ─────────────────────────────────────────────────────
	const [error, setError] = useState<string | null>(null);

	// ── Loaded env dicts keyed by `slotId:scope:scopeId` ────────────────
	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});

	// ── Permission flags ────────────────────────────────────────────────
	const orgId = authUser?.organization?.id;
	const teams = authUser?.organization?.teams;
	// ConnectResult.devTeam IS the dev team id ('' when unset). After an org
	// switch it can still name a team from a DIFFERENT org, which the active
	// org doesn't contain — a foreign id would sail past the non-empty `||`
	// guard, resolve isTeamAdmin=false, and drive team-scope env reads/writes
	// against a team the server rejects. Honor devTeam ONLY when it belongs to
	// the active org's teams; otherwise fall back to the first team.
	const devTeamId = authUser?.devTeam;
	const teamId = (devTeamId && teams?.some((t: any) => t.id === devTeamId))
		? devTeamId
		: teams?.[0]?.id;
	const isOrgAdmin = authUser?.organization?.permissions?.includes('org.admin') ?? false;
	const isTeamAdmin = teamId ? (teams?.find((t: any) => t.id === teamId)?.permissions?.includes('team.admin') ?? false) : false;

	// ── Single slot config ──────────────────────────────────────────────
	const slots: EnvironmentSlotConfig[] = [
		{
			id: 'default',
			label: 'Environment',
			isConnected,
			isSaas,
			isOrgAdmin,
			isTeamAdmin,
			orgId,
			teamId,
		},
	];

	// ── Load callback ───────────────────────────────────────────────────
	/**
	 * Fetches env data for a scope and stores it in the envs dict.
	 *
	 * @param slotId - Slot identifier (always 'default' in shell).
	 * @param scope - Env scope: 'org', 'team', or 'user'.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 */
	const handleLoadEnv = useCallback(
		(slotId: string, scope: EnvironmentScope, scopeId?: string) => {
			if (!isConnected) return;
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			(ConnectionManager.getInstance().request('client.account.getEnv', { scope, scopeId }) as Promise<Record<string, string>>)
				.then((env) => {
					setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
					setError(null);
				})
				.catch((err: Error) => {
					// Store empty dict so the card exits the loading state
					setEnvs((prev) => ({ ...prev, [cacheKey]: prev[cacheKey] ?? {} }));
					setError(err.message);
				});
		},
		[isConnected]
	);

	// ── Save callback ───────────────────────────────────────────────────
	/**
	 * Persists env data for a scope and updates the local cache.
	 *
	 * @param slotId - Slot identifier (always 'default' in shell).
	 * @param scope - Env scope: 'org', 'team', or 'user'.
	 * @param env - The full env dict to save.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 */
	const handleSaveEnv = useCallback(
		async (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => {
			if (!isConnected) return;
			await ConnectionManager.getInstance().request('client.account.setEnv', { scope, env, scopeId });
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
		},
		[isConnected]
	);

	// ── Render ───────────────────────────────────────────────────────────
	return <EnvironmentView slots={slots} envs={envs} onLoadEnv={handleLoadEnv} onSaveEnv={handleSaveEnv} error={error} />;
};

export default EnvironmentProvider;
