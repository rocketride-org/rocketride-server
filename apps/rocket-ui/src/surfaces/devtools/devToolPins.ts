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
// DEV-TOOL PINS — the strip's membership and order, shell-partition backed
// =============================================================================
//
// THREE INDEPENDENT LAYERS (settled 2026-10-19; see
// shared/tools/core/devToolCatalog.ts for the full doctrine):
//
//   CATALOG  what the caller can reach  — rrext_app list, fetched here
//   DESKTOP  what the user has GOT      — the store surface's business,
//                                         never consulted by the strip
//   STRIP    this workspace's sidebar   — the pins + order below
//
// Pins and order live in the SHELL PARTITION of the workspace prefs — the
// same bag VS Code's DevToolStore writes — so both hosts read one strip per
// server workspace, and the list cannot change underfoot when the active
// app switches (the old home, the active app's bag, did exactly that).
//
// The pinned TABS still resolve against the login manifest (appManifest):
// a tab must be loadable this session, and the manifest is the loadable
// set. The PICKER list is the fetched catalog — a reachable tool that is
// not yet loadable may be pinned; its tab mounts once the manifest carries
// it (the same tolerance VS Code's bare-row fallback gives).
// =============================================================================

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ConnectionManager, realmPrefsHub, registerSettings, useWorkspace } from 'shell';
import { TOOL_SETTINGS_GROUP } from 'shared/tools/toolSettings';
import type { AppManifestEntry, PrefsStore } from 'shell';
import { applyContainerOrder, containerIdOf, readDevToolPins, storeToolIds, DEV_TOOL_PINS_KEY } from 'shell/src/workspace/devToolPins';
import { builtinServesHost, getBuiltinTools } from 'shared/tools/core';
import { appPartition } from 'shell/src/workspace/workspaceStore';
import { fetchDevToolCatalog } from 'shared/tools/core/devToolCatalog';
import type { ToolTab } from 'shared/tools/core/chrome/types';


/** A manifest entry's dev-tool membership (`categories` contains 'devTool'). */
export function isDevTool(entry: AppManifestEntry): boolean {
	return (entry.categories ?? []).some((c) => String(c).toLowerCase() === 'devtool');
}

/** Maps a manifest/catalog entry to the shared sidebar's ToolTab row shape. */
export function toToolTab(entry: Pick<AppManifestEntry, 'id' | 'name' | 'icon' | 'version' | 'description' | 'moduleId' | 'registryVersion'>): ToolTab {
	return {
		id: entry.id,
		name: entry.name,
		...(entry.icon ? { iconUrl: entry.icon } : {}),
		...(entry.version ? { version: entry.version } : {}),
		...(entry.description ? { description: entry.description } : {}),
		moduleId: entry.moduleId,
		...(entry.registryVersion !== undefined ? { registryVersion: entry.registryVersion } : {}),
	};
}

// ── The strip's prefs ───────────────────────────────────────────────────────
// The REALM's hub owns one mirrored store per partition; this is the ACTIVE
// APP's — the toolbar is app state, kept in that app's workspace file, not
// in global.json (which is for what the shell itself is).
function appPrefsStore(appId: string): PrefsStore {
	return realmPrefsHub(ConnectionManager.getInstance()).partition(appPartition(appId));
}

// ── The catalog: one page-level fetch, refreshed on account change ──────────
// A tiny external store rather than per-hook state so N consumers share one
// in-flight request and one entries array (stable identity between loads).
const catalogStore = {
	entries: null as AppManifestEntry[] | null,
	subs: new Set<() => void>(),
	inFlight: false,
	wired: false,
};

async function refreshCatalog(): Promise<void> {
	if (catalogStore.inFlight) return;
	const cm = ConnectionManager.getInstance();
	if (!cm.isConnected()) return;
	catalogStore.inFlight = true;
	try {
		// The realm's client — the real one here in the root, exactly the
		// call every webview realm makes on its realm client. One path.
		catalogStore.entries = await fetchDevToolCatalog(cm.getClient());
		for (const cb of [...catalogStore.subs]) cb();
	} catch {
		/* transient — the next connect/account event refetches */
	} finally {
		catalogStore.inFlight = false;
	}
}

/** Idempotent: the first caller wires the refresh triggers for the page. */
function wireCatalog(): void {
	if (catalogStore.wired) return;
	catalogStore.wired = true;
	const cm = ConnectionManager.getInstance();
	// Account changes move the reachable set (@me/@team rows, new publishes
	// pushed via apaevt_account); connects establish it.
	cm.on('shell:connected', () => void refreshCatalog());
	cm.on('shell:accountUpdate', () => void refreshCatalog());
	void refreshCatalog();
}

function subscribeCatalog(cb: () => void): () => void {
	catalogStore.subs.add(cb);
	return () => {
		catalogStore.subs.delete(cb);
	};
}
const catalogSnapshot = (): AppManifestEntry[] | null => catalogStore.entries;

/** What {@link useDevToolPins} returns. */
export interface DevToolPins {
	/** The RAW toolbar list — order AND enablement in one array. */
	list: string[];
	/** Persists a new toolbar list. */
	setList: (next: string[]) => void;
	/** STORE tool app ids in the list, in order — what needs loading. */
	pins: string[];
	/** The same list as chrome container ids — the toolbar order. */
	tabOrder: string[];
	/** The reachable dev-tool catalog (rrext_app list), manifest-shaped;
	 *  null until the first fetch resolves (surfaces render Loading). */
	catalog: AppManifestEntry[] | null;
	/** Pinned tools resolved against the login manifest, as ToolTab rows. */
	pinnedTools: ToolTab[];
	/** Pins a tool at the END of the strip (no-op when already pinned). */
	pin: (appId: string) => void;
	/** Unpins a tool — the strip only; never a desktop verb. */
	unpin: (appId: string) => void;
	/** Persists a new strip order. */
	setTabOrder: (orderedIds: string[]) => void;
}

/**
 * The pinned dev tools, strip order, and catalog — one hook. Every consumer
 * (sidebar content, rail containers, readme page) re-renders through the
 * shared stores when any of them changes a pin.
 */
export function useDevToolPins(): DevToolPins {
	const { appManifest, activeAppId } = useWorkspace();
	wireCatalog();

	const store = appPrefsStore(activeAppId);
	const prefsSnap = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	const catalog = useSyncExternalStore(subscribeCatalog, catalogSnapshot, catalogSnapshot);

	// ONE list: the toolbar order AND the tool set (workspace/devToolPins).
	const list = useMemo<string[]>(() => readDevToolPins(prefsSnap), [prefsSnap]);
	const pins = useMemo<string[]>(() => storeToolIds(list), [list]);
	const tabOrder = useMemo<string[]>(() => list.map(containerIdOf), [list]);

	// Pins resolve against the manifest; an id the server no longer lists is
	// kept OUT of the rows (nothing to mount) but stays in the pin list so it
	// reappears if the server lists it again — same tolerance as VS Code's
	// meta-cache fallback, without the cache.
	const pinnedTools = useMemo<ToolTab[]>(() => {
		const byId = new Map(appManifest.map((a) => [a.id, a]));
		return pins.map((id) => byId.get(id)).filter((a): a is AppManifestEntry => !!a).map(toToolTab);
	}, [pins, appManifest]);

	// A pinned STORE tool with `configuration` contributes a settings section
	// WHILE pinned (builtins register their own at startup, for the host's
	// lifetime — registration follows the functionality's lifetime). Unpinning
	// disposes the registration, removing the section live; the tool's deltas
	// stay in its partition file and revive on re-pin.
	useEffect(() => {
		const offs = pins
			.map((id) => appManifest.find((a) => a.id === id))
			.filter((a): a is AppManifestEntry => !!a && !!a.configuration)
			.map((a) =>
				registerSettings({
					appId: a.id,
					name: a.name,
					...(a.shells ? { shells: a.shells } : {}),
					group: TOOL_SETTINGS_GROUP,
					configuration: a.configuration!,
				}),
			);
		return () => offs.forEach((off) => off());
	}, [pins, appManifest]);

	const pin = useCallback((appId: string) => {
		if (list.includes(appId)) return;
		// FIRST pin has to materialise the list: an EMPTY list means "never
		// arranged — every builtin shows", but a list that EXISTS is the
		// enablement allowlist. Appending to the empty list would therefore
		// silently disable every builtin tab (the pane stack then falls back
		// to this very pin while the rail still shows the builtin icons).
		// Same rule as useToolStrip's toggleBuiltin materialisation.
		const base = list.length === 0
			// A builtin's manifest id IS its pin id (`builtin.<tool>`).
			? getBuiltinTools().filter((t) => builtinServesHost(t, 'rocket')).map((t) => t.manifest.id)
			: list;
		store.set(DEV_TOOL_PINS_KEY, [...base, appId]);
	}, [list, store]);

	const unpin = useCallback((appId: string) => {
		store.set(DEV_TOOL_PINS_KEY, list.filter((id) => id !== appId));
	}, [list, store]);

	// The chrome hands back ITS container ids; entries it never declared keep
	// their slot (a store tool the server has not listed this session).
	const setList = useCallback((next: string[]) => {
		store.set(DEV_TOOL_PINS_KEY, next);
	}, [store]);

	const setTabOrder = useCallback((orderedIds: string[]) => {
		store.set(DEV_TOOL_PINS_KEY, applyContainerOrder(orderedIds, list));
	}, [list, store]);

	return { list, setList, pins, tabOrder, catalog, pinnedTools, pin, unpin, setTabOrder };
}
