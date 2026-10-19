// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentWebview — the Variables framework page as a shell bus realm.
 *
 * Renders the shell's host-agnostic EnvironmentView with TWO connection
 * slots (development / deployment). Env reads and writes are the brokered
 * `client.account.getEnv/setEnv` ops carrying the slot's `connection`
 * dimension — the extension host's broker resolves deploy against the
 * DeployManager, whose state never leaves that process. Slot state
 * (connected / saas / admin flags per slot) therefore arrives via its own
 * host ops: `host.envSlots` (pull at mount) + `host.envSlotsChanged` (push).
 *
 * The missing-keys prefill (the pre-run env gate) is `env.getPrefill`
 * (pull, covers open-with-args) + `env.prefill` (push, covers an already
 * open page).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionManager, EnvironmentView } from 'shell';
import type { EnvironmentSlotConfig, EnvironmentScope } from 'shell';
import type { EnvSlotState, EnvSlotsPayload } from 'shared/ops/hostOps';
import { attachBusRealm } from '../hooks/busRealm';

attachBusRealm();

/** The env ops' connection dimension for a slot id. */
const connectionOf = (slotId: string): 'dev' | 'deploy' => (slotId === 'deployment' ? 'deploy' : 'dev');

/**
 * VS Code webview entry point for the Environment page.
 */
const EnvironmentWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();

	// ── State ────────────────────────────────────────────────────────────
	const [ready, setReady] = useState(false);
	const [shared, setShared] = useState(false);
	const [slots, setSlots] = useState<Record<string, EnvSlotState>>({});
	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});
	const [error, setError] = useState<string | null>(null);
	const [requiredKeys, setRequiredKeys] = useState<string[]>([]);
	const requiredKeysRef = useRef<string[]>([]);

	// ── Slot feed: pull once at mount, push on host-side changes ─────────
	useEffect(() => {
		const apply = (payload: EnvSlotsPayload): void => {
			setShared(payload.shared);
			setSlots((prev) => {
				const next: Record<string, EnvSlotState> = {};
				for (const s of payload.slots) next[s.slot] = s;
				// A slot that just disconnected drops its cached env dicts so
				// a reconnect reloads fresh instead of showing stale values.
				for (const s of payload.slots) {
					if (!s.isConnected && prev[s.slot]?.isConnected) {
						setEnvs((prevEnvs) => {
							const kept: Record<string, Record<string, string> | undefined> = {};
							for (const [key, val] of Object.entries(prevEnvs)) {
								if (!key.startsWith(`${s.slot}:`)) kept[key] = val;
							}
							return kept;
						});
					}
				}
				return next;
			});
			setReady(true);
		};
		const off = cm.handle('host.envSlotsChanged', (p) => apply(p as EnvSlotsPayload));
		void cm.request('host.envSlots', {}).then(
			(p) => apply(p as EnvSlotsPayload),
			() => { /* host not ready — the first push will seed us */ }
		);
		return off;
	}, [cm]);

	// ── Prefill (missing-keys gate): pull covers open-with-args; push
	//    covers an already-open page getting new keys. ────────────────────
	useEffect(() => {
		const applyKeys = (keys: string[]): void => {
			if (!keys.length) return;
			const userKey = 'development:user:';
			setEnvs((prev) => {
				const merged = { ...(prev[userKey] ?? {}) };
				for (const key of keys) {
					if (!(key in merged)) merged[key] = '';
				}
				return { ...prev, [userKey]: merged };
			});
			setRequiredKeys(keys);
			requiredKeysRef.current = keys;
		};
		const off = cm.handle('env.prefill', (p) => applyKeys((p as { keys: string[] }).keys));
		void cm.request('env.getPrefill', {}).then(
			(r) => applyKeys((r as { keys: string[] }).keys ?? []),
			() => { /* no prefill */ }
		);
		return off;
	}, [cm]);

	// ── Env load/save over the brokered ops ──────────────────────────────

	/** Fetches env data for a slot+scope and stores it in the envs dict. */
	const handleLoadEnv = useCallback(
		(slotId: string, scope: EnvironmentScope, scopeId?: string) => {
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			(cm.request('client.account.getEnv', { scope, scopeId, connection: connectionOf(slotId) }) as Promise<Record<string, string>>)
				.then((env) => {
					// Merge required keys into the development user scope so the
					// gate's missing keys render as empty editable rows.
					if (slotId === 'development' && scope === 'user' && requiredKeysRef.current.length > 0) {
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

	/** Persists env data for a slot+scope and updates the local cache. */
	const handleSaveEnv = useCallback(
		async (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => {
			await cm.request('client.account.setEnv', { scope, env, scopeId, connection: connectionOf(slotId) });
			const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
			setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
			setError(null);
		},
		[cm]
	);

	// ── Build slot configs for the shared EnvironmentView ────────────────
	const buildSlotConfigs = (): EnvironmentSlotConfig[] => {
		const slotIds = shared ? ['development'] : ['development', 'deployment'];
		return slotIds
			.filter((id) => slots[id])
			.map((id) => {
				const s = slots[id];
				return {
					id,
					label: id === 'development' ? 'Development' : 'Deployment',
					isConnected: s.isConnected,
					isSaas: s.isSaas,
					isOrgAdmin: s.isOrgAdmin,
					isTeamAdmin: s.isTeamAdmin,
					orgId: s.orgId,
					teamId: s.teamId,
				};
			});
	};

	// ── Render ───────────────────────────────────────────────────────────

	if (!ready) return null;

	return (
		<EnvironmentView
			slots={buildSlotConfigs()}
			envs={envs}
			onLoadEnv={handleLoadEnv}
			onSaveEnv={handleSaveEnv}
			requiredKeys={requiredKeys}
			error={error}
		/>
	);
};

export default EnvironmentWebview;
