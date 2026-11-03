// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentSection — ONE connection slot's Environment Variables pane,
 * rendered as a rich section of the Settings page (the standalone Variables
 * framework page is gone; the Settings nav is the server selector when the
 * dev and deploy connections differ).
 *
 * Env reads and writes are the `host.env.get/set` ops carrying the slot's
 * `connection` dimension — the extension host resolves deploy against the
 * DeployManager, whose state never leaves that process (which is why this
 * does not use the realm client: that always rides the primary connection).
 *
 * The missing-keys prefill (the pre-run env gate) arrives as a prop from the
 * Settings open args — passed to the DEVELOPMENT section only (runs execute
 * against the dev connection) and seeded into this slot's user scope.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionManager, EnvironmentView } from 'shell';
import type { EnvironmentSlotConfig, EnvironmentScope } from 'shell';
import type { EnvSlotState } from 'shared/ops/hostOps';

/** The env ops' connection dimension for a slot. */
const connectionOf = (slot: string): 'dev' | 'deploy' => (slot === 'deployment' ? 'deploy' : 'dev');

/** Props: the slot's live state (fed by the parent's host.envSlots feed). */
export interface IEnvironmentSectionProps {
	/** The slot's host-side state (connected/saas/admin flags, scope ids). */
	slot: EnvSlotState;
	/** The slot card's label ('Environment' when shared, else the slot name). */
	label: string;
	/** Missing-variable keys to seed as empty required rows (user scope). */
	requiredKeys?: string[];
}

/**
 * One slot's Environment Variables pane.
 */
export const EnvironmentSection: React.FC<IEnvironmentSectionProps> = ({ slot, label, requiredKeys }) => {
	const cm = ConnectionManager.getInstance();

	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});
	const [error, setError] = useState<string | null>(null);

	// The load callback captures the CURRENT gate without re-identity churn.
	const requiredKeysRef = useRef<string[]>(requiredKeys ?? []);
	requiredKeysRef.current = requiredKeys ?? [];

	// A slot that just disconnected drops its cached env dicts so a reconnect
	// reloads fresh instead of showing stale values.
	const wasConnected = useRef(slot.isConnected);
	useEffect(() => {
		if (!slot.isConnected && wasConnected.current) setEnvs({});
		wasConnected.current = slot.isConnected;
	}, [slot.isConnected]);

	/** Fetches env data for a scope and stores it in the envs dict. */
	const handleLoadEnv = useCallback(
		(slotId: string, scope: EnvironmentScope, scopeId?: string) => {
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			(cm.request('host.env.get', { scope, scopeId, connection: connectionOf(slotId) }) as Promise<Record<string, string>>)
				.then((env) => {
					// Merge the gate's keys into the user scope so the missing
					// variables render as empty editable rows.
					if (scope === 'user' && requiredKeysRef.current.length > 0) {
						env = { ...env };
						for (const key of requiredKeysRef.current) {
							if (!(key in env)) env[key] = '';
						}
					}
					setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
					setError(null);
				})
				.catch((err: Error) => {
					// Store empty dict so the card exits the loading state
					setEnvs((prev) => ({ ...prev, [cacheKey]: prev[cacheKey] ?? {} }));
					setError(err.message);
				});
		},
		[cm]
	);

	/** Persists env data for a scope and updates the local cache. */
	const handleSaveEnv = useCallback(
		async (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => {
			await cm.request('host.env.set', { scope, env, scopeId, connection: connectionOf(slotId) });
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
			setError(null);
		},
		[cm]
	);

	const slotConfig: EnvironmentSlotConfig = {
		id: slot.slot,
		label,
		isConnected: slot.isConnected,
		isSaas: slot.isSaas,
		isOrgAdmin: slot.isOrgAdmin,
		isTeamAdmin: slot.isTeamAdmin,
		...(slot.orgId !== undefined ? { orgId: slot.orgId } : {}),
		...(slot.teamId !== undefined ? { teamId: slot.teamId } : {}),
	};

	return (
		<EnvironmentView
			slots={[slotConfig]}
			envs={envs}
			onLoadEnv={handleLoadEnv}
			onSaveEnv={handleSaveEnv}
			{...(requiredKeys && requiredKeys.length > 0 ? { requiredKeys } : {})}
			error={error}
		/>
	);
};
