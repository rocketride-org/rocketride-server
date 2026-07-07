// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * EnvironmentWebview — VS Code messaging bridge for the shared EnvironmentView.
 *
 * Translates `env:*` postMessage events from EnvironmentProvider into pure
 * props for the host-agnostic EnvironmentView component. All rendering is
 * delegated to shared-ui; this file only manages messaging state.
 *
 * Architecture:
 *   EnvironmentProvider (Node.js) <-> postMessage <-> EnvironmentWebview (browser)
 *     -> EnvironmentView (shared-ui)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { EnvironmentView } from 'shared/modules/environment';
import type { EnvironmentSlotConfig, EnvironmentScope } from 'shared/modules/environment';
import { useMessaging } from '../hooks/useMessaging';
import type { EnvironmentHostToWebview, EnvironmentWebviewToHost, EnvironmentSlotState } from '../types';

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * VS Code webview entry point for the Environment page.
 *
 * Receives env:* messages from EnvironmentProvider, maintains local state,
 * and passes pure props to the shared EnvironmentView.
 */
const EnvironmentWebview: React.FC = () => {
	// ── State ────────────────────────────────────────────────────────────
	/** Whether the init message has been received. */
	const [ready, setReady] = useState(false);

	/** Whether deployment shares the development target. */
	const [shared, setShared] = useState(false);

	/** Per-slot connection state keyed by slot name. */
	const [slots, setSlots] = useState<Record<string, EnvironmentSlotState>>({});

	/** Loaded env dicts keyed by `slotId:scope:scopeId`. */
	const [envs, setEnvs] = useState<Record<string, Record<string, string> | undefined>>({});

	/** Page-level error message. */
	const [error, setError] = useState<string | null>(null);

	/** Keys that must have non-empty values before save is allowed. */
	const [requiredKeys, setRequiredKeys] = useState<string[]>([]);
	const requiredKeysRef = useRef<string[]>([]);

	/** Ref to the latest sendMessage so callbacks don't go stale. */
	const sendMessageRef = useRef<(msg: EnvironmentWebviewToHost) => void>(() => {});

	/**
	 * Pending save resolvers keyed by `slot:scope:scopeId`.
	 * Resolved when env:data arrives for that key, rejected on env:error.
	 */
	const pendingSavesRef = useRef<Map<string, { resolve: () => void; reject: (err: Error) => void }>>(new Map());

	// ── Incoming messages ────────────────────────────────────────────────
	const handleMessage = useCallback((message: EnvironmentHostToWebview) => {
		switch (message.type) {
			case 'env:init':
				setShared(message.shared);
				setSlots(() => {
					const map: Record<string, EnvironmentSlotState> = {};
					for (const s of message.slots) map[s.slot] = s;
					return map;
				});
				setEnvs({});
				setError(null);
				setReady(true);
				break;

			case 'env:slotUpdate':
				setSlots((prev) => ({ ...prev, [message.slot.slot]: message.slot }));
				if (!message.slot.isConnected) {
					setEnvs((prev) => {
						const next: Record<string, Record<string, string> | undefined> = {};
						for (const [key, val] of Object.entries(prev)) {
							if (!key.startsWith(`${message.slot.slot}:`)) next[key] = val;
						}
						return next;
					});
				}
				break;

			case 'env:data': {
				const cacheKey = `${message.slot}:${message.scope}:${message.scopeId ?? ''}`;
				let env = message.env;
				// Merge required keys into the development user scope
				if (message.slot === 'development' && message.scope === 'user' && requiredKeysRef.current.length > 0) {
					env = { ...env };
					for (const key of requiredKeysRef.current) {
						if (!(key in env)) env[key] = '';
					}
				}
				setEnvs((prev) => ({ ...prev, [cacheKey]: env }));
				setError(null);
				// Resolve any pending save for this key (host confirmed persistence)
				pendingSavesRef.current.get(cacheKey)?.resolve();
				pendingSavesRef.current.delete(cacheKey);
				break;
			}

			case 'env:error':
				setError(message.error);
				// If the error includes scope context, clear loading state for
				// the specific cache key so the card doesn't stay stuck
				if (message.slot && message.scope) {
					const failedKey = `${message.slot}:${message.scope}:${message.scopeId ?? ''}`;
					setEnvs((prev) => {
						if (prev[failedKey] === undefined) {
							return { ...prev, [failedKey]: {} };
						}
						return prev;
					});
					// Reject any pending save for this key
					pendingSavesRef.current.get(failedKey)?.reject(new Error(message.error));
					pendingSavesRef.current.delete(failedKey);
				}
				break;

			case 'env:prefill': {
				const userKey = 'development:user:';
				setEnvs((prev) => {
					const existing = prev[userKey] ?? {};
					const merged = { ...existing };
					for (const key of message.keys) {
						if (!(key in merged)) merged[key] = '';
					}
					return { ...prev, [userKey]: merged };
				});
				setRequiredKeys(message.keys);
				requiredKeysRef.current = message.keys;
				break;
			}
		}
	}, []);

	const { sendMessage } = useMessaging<EnvironmentWebviewToHost, EnvironmentHostToWebview>({
		onMessage: handleMessage,
	});

	useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

	// ── Callbacks for EnvironmentView ────────────────────────────────────

	/** Sends a getEnv request to the extension host. */
	const handleLoadEnv = useCallback((slotId: string, scope: EnvironmentScope, scopeId?: string) => {
		sendMessageRef.current({ type: 'env:getEnv', slot: slotId as 'development' | 'deployment', scope, scopeId });
	}, []);

	/**
	 * Sends a saveEnv request and waits for the host to confirm persistence.
	 *
	 * Resolves when env:data arrives for the same key (host re-fetches and
	 * sends canonical data after a successful save). Rejects on env:error.
	 */
	const handleSaveEnv = useCallback(async (slotId: string, scope: EnvironmentScope, env: Record<string, string>, scopeId?: string) => {
		const cacheKey = `${slotId}:${scope}:${scopeId ?? ''}`;
		// Create a promise that resolves when the host confirms
		const confirmation = new Promise<void>((resolve, reject) => {
			pendingSavesRef.current.set(cacheKey, { resolve, reject });
		});
		sendMessageRef.current({ type: 'env:saveEnv', slot: slotId as 'development' | 'deployment', scope, env, scopeId });
		await confirmation;
	}, []);

	// ── Build slot configs for shared EnvironmentView ────────────────────

	/** Converts an EnvironmentSlotState to an EnvironmentSlotConfig. */
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
