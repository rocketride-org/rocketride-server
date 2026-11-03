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
// TOOLS/CORE — the one tool mount, for every host
// =============================================================================
//
// Mounting a tool used to be written once per host (rocket-ui's DevToolMount,
// the VS Code sidebar's DevToolSidebarMount). They agreed on everything that
// matters and drifted on everything else — most visibly on WHEN to mount,
// which is how one host ended up downloading every pinned tool on every page
// load while the other did not. Policy that lives in two places is policy
// that has already diverged; it just has not been noticed yet.
//
// So this component owns the whole decision — builtin-vs-store resolution,
// which descriptor surface a slot takes, the DevToolProps wiring, and every
// status/fallback state — and hosts contribute only the thing that is
// genuinely theirs: HOW A DESCRIPTOR IS OBTAINED.
//
// That one difference is real and irreducible. A framework root resolves a
// descriptor through the shell's app loader, sharing its registered remotes
// and singletons. A webview realm has no bootstrap, so it initialises its
// own Module Federation host and composes remote entry URLs itself. Both
// hand the RESULT here as props; neither gets an opinion about anything
// downstream of it.
// =============================================================================

import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AppDescriptor, DevToolProps } from 'shell';
import { getBuiltinTool } from './registry';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Bounded flex host: the tool fills it and scrolls internally. */
	host: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	/** Centered status message (loading / error / unavailable). */
	status: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		padding: '0 24px',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** How a host's descriptor load for one store tool is progressing. */
export type ToolDescriptorStatus = 'loading' | 'ready' | 'error';

/** What a host hands this mount — the descriptor and the state around it. */
export interface ToolDescriptorSource {
	/** The resolved descriptor; absent until `status` is 'ready'. */
	descriptor?: AppDescriptor | null;
	/** Load progress. Ignored for builtin tools (they never load). */
	status: ToolDescriptorStatus;
	/** Failure text for `status: 'error'`. */
	error?: string | null;
}

/** Props for {@link ToolMount}. */
export interface IToolMountProps {
	/** The tool's app id. */
	appId: string;
	/** Display name for status messages (defaults to the id). */
	name?: string;
	/** Which descriptor surface to mount. */
	slot: 'frame' | 'sidebar';
	/** The host document key this FRAME serves (per-document tools). */
	docKey?: string;
	/** For SIDEBAR mounts: the tool's fronted document key, or null when
	 *  another tab is fronted. Omit where the host cannot tell. */
	activeDocKey?: string | null;
	/** This mount's channel (frame ↔ sidebar), host-built over its transport. */
	channel: DevToolProps['channel'];
	/** The host's documents API for this tool. */
	documents?: DevToolProps['documents'];
	/** The host's descriptor load (store tools only — see the file header). */
	source?: ToolDescriptorSource;
	/**
	 * Why the tool cannot be mounted right now (e.g. no engine connection) —
	 * rendered instead of the tool, in place of any load state.
	 */
	unavailable?: string | null;
	/**
	 * Rendered when the tool declares nothing for this slot. Hosts with a
	 * richer empty state (the Dev Tools card) pass it; without one, the
	 * mount says so in words.
	 */
	fallback?: ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Mounts one surface of one tool.
 *
 * Builtin tools resolve from the in-bundle registry — no load, no
 * descriptor, and a store tool can never shadow a builtin id because the
 * registry is consulted FIRST. Store tools mount from the descriptor the
 * host resolved.
 *
 * @param props - See {@link IToolMountProps}.
 * @returns The mounted tool surface, or the matching status element.
 */
export const ToolMount: React.FC<IToolMountProps> = ({
	appId,
	name,
	slot,
	docKey,
	activeDocKey,
	channel,
	documents,
	source,
	unavailable,
	fallback,
}) => {
	const label = name ?? appId;

	// BUILTIN first: the registration route decides the tier, so a store
	// tool publishing a builtin's id resolves to the builtin, never its own.
	const builtin = getBuiltinTool(appId);

	if (!builtin) {
		if (unavailable) return <div style={styles.status}>{unavailable}</div>;
		if (source?.status === 'error') {
			return <div style={styles.status}>Could not load {label}: {source.error ?? 'unknown error'}</div>;
		}
		if (source?.status === 'loading') return <div style={styles.status}>Loading {label}…</div>;
	}

	// One descriptor surface either way — a builtin's is in the bundle, a
	// store tool's is whatever the host's load resolved.
	const descriptor = builtin ? builtin.descriptor : source?.descriptor;
	const Component = slot === 'frame' ? descriptor?.devToolFrame : descriptor?.devToolSidebar;

	if (!Component) {
		if (fallback !== undefined) return <>{fallback}</>;
		return (
			<div style={styles.status}>
				{label} does not declare a {slot === 'frame' ? 'devToolFrame' : 'devToolSidebar'}.
			</div>
		);
	}

	return (
		<div style={styles.host}>
			<Component
				channel={channel}
				{...(documents !== undefined ? { documents } : {})}
				{...(docKey !== undefined ? { docKey } : {})}
				{...(activeDocKey !== undefined ? { activeDocKey } : {})}
			/>
		</div>
	);
};

export default ToolMount;
