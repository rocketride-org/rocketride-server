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
//     own ToolHostProvider carrying ITS scoped prefs partition (isolation
//     by construction) and its per-tool peer/channel/documents wiring,
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
import { ConnectionManager, ToolHostProvider, createLoopbackPeer, scopedPrefs } from 'shell';
import type { DevToolProps, PrefsStore, ToolChannel } from 'shell';
import type { BuiltinToolServices } from '../ToolContext';
import { getBuiltinTools } from '../registry';
import type { SidebarToolItem } from './SidebarChrome';

/** One Store row for a builtin (enable/disable, never uninstall). */
export interface BuiltinStoreRow {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
}

/** What a host supplies to the strip. */
export interface ToolStripConfig {
	/** This host's id — filters builtins by their `hosts` declaration. */
	host: 'rocket' | 'vscode';
	/** The realm's services object (each item overrides `prefs` per tool). */
	services: BuiltinToolServices;
	/** The realm's prefs backend — per-tool partitions are carved off it. */
	prefsStore: PrefsStore;
	/** Disabled builtin ids (host-persisted). */
	disabledBuiltins: string[];
	/** Per-tool sidebar peer; omit for stable loopback peers. */
	peerFor?: (toolId: string) => DevToolProps['peer'];
	/** Per-tool channel; omit when the tool builds its own over the peer. */
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
	const { host, services, prefsStore, disabledBuiltins, peerFor, channelFor, documentsFor, revealTool } = config;

	// Stable loopback peers for hosts without per-tool transports — one per
	// tool for the realm's lifetime, so mounts keep their identities.
	const loopbacksRef = useRef(new Map<string, DevToolProps['peer']>());
	const resolvePeer = useCallback(
		(toolId: string): DevToolProps['peer'] => {
			if (peerFor) return peerFor(toolId);
			let peer = loopbacksRef.current.get(toolId);
			if (!peer) {
				peer = createLoopbackPeer();
				loopbacksRef.current.set(toolId, peer);
			}
			return peer;
		},
		[peerFor]
	);

	const builtinStoreRows = useMemo<BuiltinStoreRow[]>(
		() =>
			getBuiltinTools()
				.filter((t) => !t.hosts || t.hosts.includes(host))
				.map((t) => ({ id: t.id, name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), enabled: !disabledBuiltins.includes(t.id) })),
		[host, disabledBuiltins]
	);

	const builtinItems = useMemo<SidebarToolItem[]>(
		() =>
			getBuiltinTools()
				.filter((t) => (!t.hosts || t.hosts.includes(host)) && !disabledBuiltins.includes(t.id))
				.map((t) => {
					const Sidebar = t.sidebar;
					const peer = resolvePeer(t.id);
					const channel = channelFor?.(t.id);
					const documents = documentsFor?.(t.id);
					return {
						id: t.id,
						label: t.name,
						...(t.icon !== undefined ? { icon: t.icon } : {}),
						// Nested provider: this tool's services carry ITS prefs
						// partition — a tool's handle cannot address another
						// app's keys (isolation by construction).
						render: () => (
							<ToolHostProvider value={{ ...services, prefs: scopedPrefs(prefsStore, `app:${t.id}`) }}>
								<Sidebar peer={peer} {...(channel !== undefined ? { channel } : {})} {...(documents !== undefined ? { documents } : {})} />
							</ToolHostProvider>
						),
					};
				}),
		[host, disabledBuiltins, services, prefsStore, resolvePeer, channelFor, documentsFor]
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
	const builtinToolIds = useMemo(() => new Set(getBuiltinTools().filter((t) => !t.hosts || t.hosts.includes(host)).map((t) => t.id)), [host]);

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

	return { builtinItems, builtinStoreRows, focusTool, deactivateReplacedTab, announceBuiltinSelected };
}
