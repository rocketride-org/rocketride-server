// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentPage — thin shell-ui wrapper around shared-ui EnvironmentView.
 *
 * Owns all DAP fetching and auth wiring. Passes pure data and async
 * callbacks down to the host-agnostic EnvironmentView. Unlike the VS Code
 * wrapper, this page has direct access to the RocketRide client — no
 * postMessage bridge required.
 */

import React, { useState, useCallback } from 'react';
import { EnvironmentView } from 'shared/modules/environment';
import type { EnvironmentSlotConfig, EnvironmentScope } from 'shared/modules/environment';
import { useShellConnection } from '../../connection/ConnectionContext';
import { useAuthUser } from '../../hooks/useAuthUser';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Cloud-UI EnvironmentView wrapper.
 *
 * Fetches env data via the RocketRide client and delegates all rendering
 * to the shared-ui EnvironmentView. Shell-UI always has a single SaaS
 * connection, so a single slot is passed.
 */
const EnvironmentPage: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const authUser = useAuthUser();

	// ── Error state ─────────────────────────────────────────────────────
	const [error, setError] = useState<string | null>(null);

	// ── Loaded env dicts keyed by `slotId:scope:scopeId` ────────────────
	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});

	// ── Permission flags ────────────────────────────────────────────────
	const orgId = authUser?.organization?.id;
	const teamId = (authUser as any)?.defaultTeamId ?? authUser?.organization?.teams?.[0]?.id;
	const isOrgAdmin = authUser?.organization?.permissions?.includes('org.admin') ?? false;
	const isTeamAdmin = teamId
		? (authUser?.organization?.teams?.find((t: any) => t.id === teamId)?.permissions?.includes('team.admin') ?? false)
		: false;

	// ── Single slot config ──────────────────────────────────────────────
	const slots: EnvironmentSlotConfig[] = [{
		id: 'default',
		label: 'Environment',
		isConnected,
		isSaas: true,
		isOrgAdmin,
		isTeamAdmin,
		orgId,
		teamId,
	}];

	// ── Load callback ───────────────────────────────────────────────────
	/**
	 * Fetches env data for a scope and stores it in the envs dict.
	 *
	 * @param slotId - Slot identifier (always 'default' in shell-ui).
	 * @param scope - Env scope: 'org', 'team', or 'user'.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 */
	const handleLoadEnv = useCallback((slotId: string, scope: EnvironmentScope, scopeId?: string) => {
		if (!client) return;
		const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
		client.account.getEnv(scope, scopeId)
			.then((env: Record<string, string>) => {
				setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
				setError(null);
			})
			.catch((err: Error) => {
				// Store empty dict so the card exits the loading state
				setEnvs((prev) => ({ ...prev, [cacheKey]: prev[cacheKey] ?? {} }));
				setError(err.message);
			});
	}, [client]);

	// ── Save callback ───────────────────────────────────────────────────
	/**
	 * Persists env data for a scope and updates the local cache.
	 *
	 * @param slotId - Slot identifier (always 'default' in shell-ui).
	 * @param scope - Env scope: 'org', 'team', or 'user'.
	 * @param env - The full env dict to save.
	 * @param scopeId - Required for 'org' and 'team' scopes.
	 */
	const handleSaveEnv = useCallback(async (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => {
		if (!client) return;
		await client.account.setEnv(scope, env, scopeId);
		const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
		setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
	}, [client]);

	// ── Render ───────────────────────────────────────────────────────────
	return (
		<EnvironmentView
			slots={slots}
			envs={envs}
			onLoadEnv={handleLoadEnv}
			onSaveEnv={handleSaveEnv}
			error={error}
		/>
	);
};

export default EnvironmentPage;
