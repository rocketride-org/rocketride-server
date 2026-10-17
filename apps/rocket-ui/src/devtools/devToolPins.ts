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
// DEV-TOOL PINS — the pinned tool list and strip order, workspace-prefs backed
// =============================================================================
//
// The browser counterpart of the VS Code extension's DevToolStore
// (workspaceState 'rr.devTools' / 'rr.sidebarTabOrder'): which dev tools the
// user pinned and how the mode strip is ordered, persisted in the workspace
// prefs bag so both the sidebar and the rail (RocketApp's sidebarViews) read
// ONE source of truth through useWorkspace(). No icon/meta cache is needed
// here — the server app manifest is in memory from boot.
// =============================================================================

import { useCallback, useMemo } from 'react';
import { useWorkspace } from 'shell';
import type { AppManifestEntry } from 'shell';
import type { ToolTab } from 'shared/modules/sidebar/types';

/** Workspace-prefs key: pinned tool app ids, in pin order. */
const PINS_KEY = 'devToolPins';
/** Workspace-prefs key: the mode strip's tab order (mode + `tool:` ids). */
const TAB_ORDER_KEY = 'sidebarTabOrder';

/** A manifest entry's dev-tool membership (`categories` contains 'devTool'). */
export function isDevTool(entry: AppManifestEntry): boolean {
	return (entry.categories ?? []).some((c) => String(c).toLowerCase() === 'devtool');
}

/** Maps a manifest entry to the shared sidebar's ToolTab row shape. */
export function toToolTab(entry: AppManifestEntry): ToolTab {
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

/** What {@link useDevToolPins} returns. */
export interface DevToolPins {
	/** Pinned tool app ids, in pin order. */
	pins: string[];
	/** The strip's persisted tab order (mode ids and `tool:<appId>` ids). */
	tabOrder: string[];
	/** The full dev-tool catalog from the server manifest, sorted by name. */
	catalog: AppManifestEntry[];
	/** Pinned tools resolved against the catalog, as ToolTab rows. */
	pinnedTools: ToolTab[];
	/** Pins a tool (no-op when already pinned). */
	pin: (appId: string) => void;
	/** Unpins a tool. */
	unpin: (appId: string) => void;
	/** Persists a new strip order. */
	setTabOrder: (orderedIds: string[]) => void;
}

/**
 * The pinned dev tools, strip order, and catalog — one hook, prefs-backed.
 * Every consumer (sidebar content, rail containers, readme page) re-renders
 * through the workspace context when any of them changes a pin.
 */
export function useDevToolPins(): DevToolPins {
	const { prefs, updatePrefs, appManifest } = useWorkspace();

	const pins = useMemo<string[]>(() => {
		const raw = prefs?.[PINS_KEY];
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
	}, [prefs]);

	const tabOrder = useMemo<string[]>(() => {
		const raw = prefs?.[TAB_ORDER_KEY];
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
	}, [prefs]);

	const catalog = useMemo(
		() => appManifest.filter(isDevTool).slice().sort((a, b) => a.name.localeCompare(b.name)),
		[appManifest],
	);

	// Pins resolve against the manifest; an id the server no longer lists is
	// kept OUT of the rows (nothing to mount) but stays in the pin list so it
	// reappears if the server lists it again — same tolerance as VS Code's
	// meta-cache fallback, without the cache.
	const pinnedTools = useMemo<ToolTab[]>(() => {
		const byId = new Map(appManifest.map((a) => [a.id, a]));
		return pins.map((id) => byId.get(id)).filter((a): a is AppManifestEntry => !!a).map(toToolTab);
	}, [pins, appManifest]);

	const pin = useCallback((appId: string) => {
		if (pins.includes(appId)) return;
		updatePrefs({ [PINS_KEY]: [...pins, appId] });
	}, [pins, updatePrefs]);

	const unpin = useCallback((appId: string) => {
		updatePrefs({ [PINS_KEY]: pins.filter((id) => id !== appId) });
	}, [pins, updatePrefs]);

	const setTabOrder = useCallback((orderedIds: string[]) => {
		updatePrefs({ [TAB_ORDER_KEY]: orderedIds });
	}, [updatePrefs]);

	return { pins, tabOrder, catalog, pinnedTools, pin, unpin, setTabOrder };
}
