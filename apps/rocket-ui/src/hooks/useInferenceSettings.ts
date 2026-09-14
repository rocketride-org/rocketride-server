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
// USE INFERENCE SETTINGS — bring-your-own-key/model data layer (Phase 5, Task 5)
// =============================================================================
//
// Backs the inference-settings panel (Task 6): loads the provider catalog
// (`GET /agent/providers`) — which now carries each provider's selectable
// MODELS (native providers' models come from opencode's own built-in catalog
// server-side; openai-compatible providers carry a curated list) — plus the
// user's stored key PRESENCE + chosen model (`account.getEnv('user')`, never
// the raw key values). `save` re-reads the user env immediately before writing
// so a concurrent change (another tab, another setting) is never clobbered by a
// stale merge base.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { getClient } from 'shell';
import { agentApi } from '../services/agentApi';
import type { AgentProvider } from '../services/agentTypes';

/** User-variable name that carries the chosen `<opencodeProviderId>/<modelId>` model string (mirrors rocket-agent's keys.ts MODEL_VAR). */
const MODEL_VAR = 'ROCKETRIDE_AGENT_MODEL';

/** One selectable model option, pre-built for a `<select>` — `value` is the full `<providerId>/<modelId>` model string the agent expects. */
export interface ModelOption {
	value: string;
	title: string;
}

/** Return shape of {@link useInferenceSettings}. */
export interface UseInferenceSettingsResult {
	/** The provider catalog, as returned by `GET /agent/providers`. */
	providers: AgentProvider[];
	/** Selectable models per provider id (from the `/agent/providers` catalog) — empty array while loading. */
	models: Record<string, ModelOption[]>;
	/** The currently-saved model string (`ROCKETRIDE_AGENT_MODEL`), or undefined if unset. */
	currentModel: string | undefined;
	/** Per-provider key PRESENCE (never the value) — true when that provider's `keyVar` is set and non-empty. */
	keyStatus: Record<string, boolean>;
	/** True while a `save()` call is in flight. */
	saving: boolean;
	/**
	 * Merges `nextKeys` and `nextModel` into the user's env and persists it.
	 *
	 * @param nextKeys - Provider id -> new key value, only for keys the caller actually changed.
	 *   A falsy value (`undefined` or `''`) clears that provider's `keyVar`; every other user
	 *   variable (including other providers' keys) is read fresh and carried over untouched.
	 * @param nextModel - The new `ROCKETRIDE_AGENT_MODEL` value; omit to leave it unchanged.
	 */
	save: (nextKeys: Record<string, string | undefined>, nextModel?: string) => Promise<void>;
	/** Re-runs the initial load (providers + env + models). */
	reload: () => void;
}

/**
 * Loads the inference-settings data (providers, key presence, current model,
 * per-provider model catalogs) and exposes a merge-safe `save`.
 */
export function useInferenceSettings(): UseInferenceSettingsResult {
	const [providers, setProviders] = useState<AgentProvider[]>([]);
	const [models, setModels] = useState<Record<string, ModelOption[]>>({});
	const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
	const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
	const [saving, setSaving] = useState(false);
	const [reloadTick, setReloadTick] = useState(0);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();

		(async () => {
			const { providers: list } = await agentApi.getProviders(controller.signal);
			if (cancelled) return;
			setProviders(list);

			// Models ride along with the provider catalog now — build the per-provider
			// `<select>` options from each provider's `models` (native: opencode's built-in
			// catalog, resolved server-side; openai-compatible: the registry's curated list).
			setModels(Object.fromEntries(list.map((p) => [p.id, p.models.map((m) => ({ value: `${p.id}/${m.id}`, title: m.title }))])));

			const client = getClient();
			// Optional chaining short-circuits the WHOLE chain (including `.catch`)
			// when client is null, so this is safe with no client connected.
			const env = (await client?.account.getEnv('user').catch(() => ({}) as Record<string, string>)) ?? {};
			if (cancelled) return;
			setCurrentModel(env[MODEL_VAR] || undefined);
			setKeyStatus(Object.fromEntries(list.map((p) => [p.id, Boolean(env[p.keyVar])])));
		})().catch(() => {
			if (cancelled) return;
			setProviders([]);
			setModels({});
			setKeyStatus({});
			setCurrentModel(undefined);
		});

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [reloadTick]);

	const reload = useCallback(() => setReloadTick((t) => t + 1), []);

	// Cross-instance sync: `save` dispatches `rocketride:envKeysChanged`, so every mounted
	// instance (e.g. the chat header's, separate from the gear panel's) reloads its key
	// presence + current model when any panel saves — no stale "Model: …" after a change.
	useEffect(() => {
		const handler = (): void => reload();
		window.addEventListener('rocketride:envKeysChanged', handler);
		return () => window.removeEventListener('rocketride:envKeysChanged', handler);
	}, [reload]);

	const save = useCallback(
		async (nextKeys: Record<string, string | undefined>, nextModel?: string) => {
			const client = getClient();
			if (!client) return;
			setSaving(true);
			try {
				// Read-merge-write: never trust the in-memory keyStatus snapshot as
				// the write base — another tab/panel may have changed other vars
				// since this hook last loaded.
				const current = await client.account.getEnv('user');
				const merged: Record<string, string> = { ...current };
				for (const provider of providers) {
					if (!(provider.id in nextKeys)) continue;
					const value = nextKeys[provider.id];
					if (value) merged[provider.keyVar] = value;
					else delete merged[provider.keyVar];
				}
				if (nextModel !== undefined) merged[MODEL_VAR] = nextModel;
				await client.account.setEnv('user', merged);
				reload();
				// Existing event (see ProjectProvider) — refreshes the pipeline
				// canvas's ${...} env-var autocomplete too.
				window.dispatchEvent(new CustomEvent('rocketride:envKeysChanged'));
			} finally {
				setSaving(false);
			}
		},
		[providers, reload]
	);

	return { providers, models, currentModel, keyStatus, saving, save, reload };
}
