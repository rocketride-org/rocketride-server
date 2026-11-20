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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// USE TOOL STRIP — the hosts' shared builtin-strip glue
// =============================================================================
//
// Everything about the builtin tool tabs that is NOT a host verb, stated
// once (it used to be twin code in both hosts, down to the comments):
//
//   - the Store rows (enable/disable, never uninstall),
//   - the strip items: each enabled builtin's sidebar mounted under its
//     own ToolHostProvider carrying ITS OWN mirrored prefs partition (isolation
//     by construction) and its per-tool channel/documents wiring,
//   - the activation/deactivation discipline: selecting a tool tab emits
//     `shell:toolSidebarActivated` and reveals (never creates) a window;
//     the tab it REPLACED gets `shell:toolSidebarDeactivated` first, and
//     same-tab reselects emit nothing.
//
// Hosts supply only their verbs (reveal, per-tool transports) and their
// persistence (mode state, disabled list). A host without per-tool
// transports gets stable loopback peers (builtins with no isolated frame).
// =============================================================================

import { useCallback, useMemo, useRef } from 'react';
import { ConnectionManager, ToolHostProvider, createLoopbackPeer, createToolChannel } from 'shell';
import { appPartition } from 'shell/src/workspace/workspaceStore';
import type { DevToolProps, IPrefsHub, ToolChannel } from 'shell';
import type { BuiltinToolServices } from '../ToolContext';
import { builtinServesHost, getBuiltinTools } from '../registry';
import { isStoreToolPin, pinIdOf } from 'shell/src/workspace/devToolPins';
import type { SidebarToolItem } from './SidebarChrome';

/** One Store row for a builtin (enable/disable, never uninstall) — the
 *  manifest row's display fields plus this person's enablement. */
export interface BuiltinStoreRow {
	/** The bare tool id (what {@link ToolStrip.toggleBuiltin} takes). */
	id: string;
	name: string;
	description?: string;
	/** The manifest's icon asset URL. */
	icon?: string;
	enabled: boolean;
}

/** What a host supplies to the strip. */
export interface ToolStripConfig {
	/** This host's id — filters builtins by their `hosts` declaration. */
	host: 'rocket' | 'vscode';
	/** The realm's services object (each item overrides `prefs` per tool). */
	services: BuiltinToolServices;
	/** The realm's prefs hub — each tool gets its OWN mirrored partition
	 *  (`app:<id>`), which is a separate retained topic, not a key prefix. */
	prefsHub: IPrefsHub;
	/**
	 * The one toolbar list (`devToolPins`), which IS the enablement:
	 * a builtin is enabled when the list names it, disabled when it does
	 * not. No second key can disagree with the list.
	 *
	 * EMPTY means untouched, not "everything off" — a person who has never
	 * arranged their toolbar sees every builtin.
	 */
	pins: readonly string[];
	/** Persists a new toolbar list. */
	onPinsChange: (next: string[]) => void;
	/** Per-tool sidebar channel; omit for stable loopback channels (builtins
	 *  with no isolated frame document). */
	channelFor?: (toolId: string) => ToolChannel;
	/** Per-tool documents API; omit on hosts without one for builtins. */
	documentsFor?: (toolId: string) => NonNullable<DevToolProps['documents']>;
	/** Reveals an open window of the tool — NEVER creates one (the tool's
	 *  own panel decides what documents open). */
	revealTool: (toolId: string) => void;
}

/** What the hook returns. */
export interface ToolStrip {
	/** The builtin tabs for SidebarChrome. */
	builtinItems: SidebarToolItem[];
	/** The Store's builtin rows. */
	builtinStoreRows: BuiltinStoreRow[];
	/** Flips one builtin's enablement in the toolbar list. */
	toggleBuiltin: (toolId: string, enabled: boolean) => void;
	/** Strip tab focus: activation emit + host reveal. */
	focusTool: (toolId: string) => void;
	/** Call on every mode change BEFORE committing it: emits the
	 *  deactivation for a replaced tool tab (same-tab reselects: nothing).
	 *  Covers MF pins (`tool:` ids) AND builtin tool tabs (bare ids). */
	deactivateReplacedTab: (prev: string, next: string) => void;
	/** Call on every strip SELECTION of a bare-id tab: emits the activation
	 *  for a builtin tool (the single-pane contract — a tool opens its pane
	 *  on activation). MF pins get theirs via {@link focusTool}; non-tool
	 *  modes emit nothing. */
	announceBuiltinSelected: (tabId: string) => void;
}

/**
 * The hosts' shared builtin-strip derivations and tab discipline.
 *
 * @param config - The host's verbs and persistence state.
 * @returns Strip items, store rows, and the activation handlers.
 */
export function useToolStrip(config: ToolStripConfig): ToolStrip {
	const { host, services, prefsHub, pins, onPinsChange, channelFor, documentsFor, revealTool } = config;

	// Stable loopback channels for hosts without per-tool transports — one
	// per tool for the realm's lifetime, so mounts keep their identities (a
	// channel holds one standing transport subscription).
	const loopbacksRef = useRef(new Map<string, ToolChannel>());
	const resolveChannel = useCallback(
		(toolId: string): ToolChannel => {
			if (channelFor) return channelFor(toolId);
			let channel = loopbacksRef.current.get(toolId);
			if (!channel) {
				channel = createToolChannel(createLoopbackPeer());
				loopbacksRef.current.set(toolId, channel);
			}
			return channel;
		},
		[channelFor]
	);

	/** Enabled = named by the list. An empty list is "never arranged", so
	 *  everything shows; only a list that exists can withhold anything. */
	const isEnabled = useCallback(
		(toolId: string) => pins.length === 0 || pins.includes(pinIdOf(toolId)),
		[pins],
	);

	/**
	 * Flips one builtin by adding it to the list or taking it out.
	 *
	 * Turning the FIRST one off has to materialise the list: until then it
	 * is empty (meaning "all of them"), and removing an id from an empty
	 * list would say nothing. The materialised list is every builtin this
	 * host serves, in registration order, plus the store tools already
	 * pinned — i.e. exactly what was on screen a moment ago.
	 */
	const toggleBuiltin = useCallback(
		(toolId: string, enabled: boolean) => {
			const pinId = pinIdOf(toolId);
			if (pins.length === 0) {
				if (enabled) return; // already shown — nothing to record
				const everything = [
					// A builtin's manifest id IS its pin id (`builtin.<tool>`).
					...getBuiltinTools().filter((t) => builtinServesHost(t, host)).map((t) => t.manifest.id),
					...pins.filter(isStoreToolPin),
				];
				onPinsChange(everything.filter((id) => id !== pinId));
				return;
			}
			if (enabled) {
				if (!pins.includes(pinId)) onPinsChange([...pins, pinId]);
				return;
			}
			onPinsChange(pins.filter((id) => id !== pinId));
		},
		[pins, host, onPinsChange],
	);

	const builtinStoreRows = useMemo<BuiltinStoreRow[]>(
		() =>
			getBuiltinTools()
				.filter((t) => builtinServesHost(t, host))
				.map((t) => ({
					id: t.descriptor.id,
					name: t.manifest.name,
					...(t.manifest.description !== undefined ? { description: t.manifest.description } : {}),
					...(t.manifest.icon !== undefined ? { icon: t.manifest.icon } : {}),
					enabled: isEnabled(t.descriptor.id),
				})),
		[host, isEnabled]
	);

	const builtinItems = useMemo<SidebarToolItem[]>(
		() =>
			getBuiltinTools()
				.filter((t) => builtinServesHost(t, host) && isEnabled(t.descriptor.id))
				.map((t): SidebarToolItem | null => {
					const toolId = t.descriptor.id;
					const Sidebar = t.descriptor.devToolSidebar;
					if (!Sidebar) return null;
					const channel = resolveChannel(toolId);
					const documents = documentsFor?.(toolId);
					return {
						id: toolId,
						label: t.manifest.name,
						...(t.descriptor.icon !== undefined ? { icon: t.descriptor.icon } : {}),
						// Nested provider: this tool's services carry ITS prefs
						// partition, keyed by the tool's MAIN APP (manifest
						// storageAppId — the pipelines tool stores under
						// rocketride.pipeBuilder) so preferences follow the person
						// across the tool and app surfaces of the same product.
						// `.workspace/` holds only `<appId>.workspace.json` files;
						// bare descriptor ids are container/channel spellings,
						// never storage identities.
						render: () => (
							<ToolHostProvider value={{ ...services, prefs: prefsHub.partition(appPartition(t.manifest.storageAppId ?? t.manifest.id)) }}>
								<Sidebar channel={channel} {...(documents !== undefined ? { documents } : {})} />
							</ToolHostProvider>
						),
					};
				})
				.filter((item): item is SidebarToolItem => item !== null),
		[host, isEnabled, services, prefsHub, resolveChannel, documentsFor]
	);

	/** Strip tab selection → reveal an open window of the tool (create none),
	 *  and announce the activation on the shell event bus — single-pane
	 *  tools react by opening their pane; per-document tools ignore it.
	 *  (The FIRST selection also lazily mounts the tool's sidebar, which
	 *  treats mounting as its first activation — see the event's docs.) */
	const focusTool = useCallback(
		(toolId: string) => {
			ConnectionManager.getInstance().emit('shell:toolSidebarActivated', { appId: toolId });
			revealTool(toolId);
		},
		[revealTool]
	);

	// This host's builtin TOOL ids — strip tabs carry them BARE (only MF pins
	// use the `tool:` prefix), so the tab discipline below must recognize both
	// spellings or builtins never hear activation/deactivation at all.
	const builtinToolIds = useMemo(() => new Set(getBuiltinTools().filter((t) => builtinServesHost(t, host)).map((t) => t.descriptor.id)), [host]);

	/** The tool id a strip tab addresses, or null for non-tool modes. */
	const toolIdOf = useCallback((tabId: string): string | null => {
		if (tabId.startsWith('tool:')) return tabId.slice('tool:'.length);
		return builtinToolIds.has(tabId) ? tabId : null;
	}, [builtinToolIds]);

	/** Deactivation for a deselected tool tab FIRST (the successor's
	 *  activation follows); same-tab reselects emit nothing. */
	const deactivateReplacedTab = useCallback((prev: string, next: string) => {
		const toolId = prev !== next ? toolIdOf(prev) : null;
		if (toolId) ConnectionManager.getInstance().emit('shell:toolSidebarDeactivated', { appId: toolId });
	}, [toolIdOf]);

	/** Activation for a selected BUILTIN tool tab (bare id; reselects re-emit,
	 *  matching the MF path through focusTool). Builtins mount in the strip
	 *  itself, so there is no window to reveal. */
	const announceBuiltinSelected = useCallback((tabId: string) => {
		if (!tabId.startsWith('tool:') && builtinToolIds.has(tabId)) {
			ConnectionManager.getInstance().emit('shell:toolSidebarActivated', { appId: tabId });
		}
	}, [builtinToolIds]);

	return { builtinItems, builtinStoreRows, toggleBuiltin, focusTool, deactivateReplacedTab, announceBuiltinSelected };
}
