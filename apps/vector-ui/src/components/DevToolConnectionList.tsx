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
// VECTOR-UI - DEV-TOOL SIDEBAR LIST (Rod's list: the parity spec S1-S9)
// =============================================================================
//
// What the dev-tool sidebar (the controller) shows, over its LOCAL env: an
// uppercase "Connections" label with a Refresh header action, one hand-built
// row per store connection (icon, name, a state dot and the state in words,
// a tooltip with the address and the sources; Enter or Space opens its
// console), and a line under the rows while discovering or when nothing was
// found. No "+ New" row (there is nothing to create), no SidebarMenu, no tool
// name (the host's tab names it), and nothing destructive: the console is
// where documents are trashed, restored and deleted, and its confirmations
// render inside that document. The full app keeps its own VectorSidebar.
// =============================================================================

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import { BxRefresh, commonStyles } from 'shell';
import { panelStyles } from 'shared/tools/core/chrome/panelStyles';
import { useEndpointsState, useEnvActiveConnection, useVectorEnv } from '../envContext';
import { VectorIcon } from '../icons';
import { connectionRow, sidebarListLine } from '../vector/connections';
import type { IBadge } from '../vector/connections';

/** A row's state dot, by the card badge's variant (the suffix says the state in words). */
const DOT_COLOR: Record<IBadge['variant'], string> = {
	success: 'var(--rr-color-success)',
	muted: 'var(--rr-text-disabled)',
	error: 'var(--rr-color-error)',
	warning: 'var(--rr-color-warning)',
};

// =============================================================================
// STYLES (the list block is Rod's, from sql-ui's SqlSidebar)
// =============================================================================

const styles = {
	/** Section container padding (the SidebarMenu geometry). */
	section: {
		padding: '2px 6px',
	} as CSSProperties,

	/** The section's header row: its label and the hover-revealed actions. */
	sectionHeader: {
		display: 'flex',
		alignItems: 'center',
	} as CSSProperties,

	/** Uppercase section header. */
	sectionLabel: {
		flex: 1,
		padding: '6px 8px 4px',
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The platform's pane-header treatment (Explorer's): a hover-revealed cluster of 18px icon buttons. */
	headerActions: commonStyles.paneHeaderActions,
	headerAction: commonStyles.paneHeaderButton,
	/** The same action while it cannot run (aria-disabled: it keeps the keyboard focus). */
	headerActionBlocked: { ...commonStyles.paneHeaderButton, opacity: 0.4, cursor: 'default' } as CSSProperties,

	/** One connection row (the compact list-row family). */
	row: (active: boolean, hovered: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '1px 8px',
		paddingLeft: 18,
		borderRadius: 5,
		fontSize: 13,
		lineHeight: '22px',
		cursor: 'pointer',
		color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
		...(active ? { background: 'var(--rr-bg-list-active)' } : null),
		...(!active && hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),

	/** Leading glyph slot. */
	rowIcon: (active: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 17,
		height: 17,
		flexShrink: 0,
		color: active ? 'inherit' : 'var(--rr-text-secondary)',
	}),

	/** Row label (fills so the state right-aligns). */
	rowLabel: {
		flex: 1,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	/** The state in words, after the name (never colour alone). */
	rowStatus: {
		flexShrink: 0,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** The state dot (the panel vocabulary's 8px dot). */
	dot: (variant: IBadge['variant']): CSSProperties => panelStyles.dot(DOT_COLOR[variant]),

	/** Muted line under the list (discovering, nothing found). */
	empty: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Failure line under the list. */
	error: {
		padding: '2px 8px 4px 18px',
		fontSize: 12,
		color: 'var(--rr-color-error)',
	} as CSSProperties,
};

/**
 * The dev-tool sidebar's connection list.
 *
 * @returns The list.
 */
export const DevToolConnectionList: React.FC = () => {
	const env = useVectorEnv();
	const { status, endpoints, probes, error } = useEndpointsState();
	const activeKey = useEnvActiveConnection();
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);
	// The header's actions show while the pointer is over the list or focus is inside it (keyboard users reach them too).
	const [paneHovered, setPaneHovered] = useState(false);
	const [paneFocused, setPaneFocused] = useState(false);
	const line = sidebarListLine(status, endpoints, error);
	// Refresh cannot run while discovery runs or the realm is offline. It says so with aria-disabled and ignores the
	// activation: a `disabled` button would drop the keyboard focus to the page, and the header cluster would fade.
	const refreshBlocked = !env.ready || status === 'loading';

	return (
		<div style={styles.section} onMouseEnter={() => setPaneHovered(true)} onMouseLeave={() => setPaneHovered(false)} onFocus={() => setPaneFocused(true)} onBlur={() => setPaneFocused(false)}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionLabel}>Connections</span>
				<div style={styles.headerActions(paneHovered || paneFocused)}>
					<button type="button" style={refreshBlocked ? styles.headerActionBlocked : styles.headerAction} title="Refresh connections" aria-label="Refresh connections" aria-disabled={refreshBlocked} onClick={() => { if (!refreshBlocked) void env.refresh(); }}>
						<BxRefresh size={18} />
					</button>
				</div>
			</div>
			{endpoints.map((e) => {
				const row = connectionRow(e, probes[e.key]);
				const active = e.key === activeKey;
				return (
					<div
						key={e.key}
						role="button"
						tabIndex={0}
						title={row.tooltip}
						aria-label={row.ariaLabel}
						aria-current={active ? 'true' : undefined}
						style={styles.row(active, hoveredKey === e.key)}
						onClick={() => env.openConsole(e)}
						onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); env.openConsole(e); } }}
						onMouseEnter={() => setHoveredKey(e.key)}
						onMouseLeave={() => setHoveredKey(null)}
					>
						<span style={styles.rowIcon(active)}><VectorIcon /></span>
						<span style={styles.rowLabel}>{row.label}</span>
						{row.status !== null && <span style={styles.rowStatus}>{row.status}</span>}
						<span style={styles.dot(row.variant)} aria-hidden="true" />
					</div>
				);
			})}
			{line && <div style={line.tone === 'error' ? styles.error : styles.empty} title={line.detail ?? undefined}>{line.text}</div>}
		</div>
	);
};

export default DevToolConnectionList;
