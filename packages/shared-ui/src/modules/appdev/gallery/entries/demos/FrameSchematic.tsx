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
// FRAME SCHEMATIC — miniature shell frame for host-chrome gallery entries
// =============================================================================

/**
 * A token-styled miniature of the shell frame used as the "demo" for host
 * chrome entries: the real chrome cannot be mounted inside the gallery, so
 * each entry renders this schematic with its zone highlighted instead. Every
 * zone is drawn with plain divs on theme tokens, so the schematic follows the
 * active theme like a live demo would.
 */

import React from 'react';
import { commonStyles } from 'shell/src/themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** The highlightable zones of the shell frame schematic. */
export type FrameZone =
	| 'sidebar'
	| 'sidebarHeader'
	| 'sidebarSlot'
	| 'sidebarFooter'
	| 'docTabs'
	| 'content'
	| 'bottomPanel'
	| 'statusBar'
	| 'debugPanel'
	| 'overlay';

/** Props for the {@link FrameSchematic} component. */
export interface IFrameSchematicProps {
	/** The zone(s) to highlight with the brand outline and label. An EMPTY
	    array renders map mode: no outlines, every top-level zone labeled —
	    used by the frame-overview entry. */
	highlight: FrameZone | FrameZone[];
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// Outer frame — a fixed miniature so proportions read at a glance
	frame: {
		position: 'relative',
		display: 'flex',
		width: 460,
		maxWidth: '100%',
		height: 280,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		background: 'var(--rr-bg-default)',
		overflow: 'hidden',
		userSelect: 'none',
	},
	// ── Sidebar column: header / scrolling slot / footer ─────────────────
	sidebar: {
		width: 104,
		flexShrink: 0,
		display: 'flex',
		flexDirection: 'column',
		borderRight: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
	sidebarHeader: {
		height: 30,
		flexShrink: 0,
		borderBottom: '1px solid var(--rr-border)',
	},
	sidebarSlot: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		padding: 8,
	},
	sidebarLine: {
		height: 8,
		borderRadius: 3,
		background: 'var(--rr-border)',
	},
	sidebarFooter: {
		height: 30,
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
	},
	// ── Main column: doc tabs / content / bottom panel / status bar ──────
	main: {
		flex: 1,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
	},
	docTabs: {
		height: 26,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'stretch',
		gap: 2,
		padding: '4px 6px 0',
		borderBottom: '1px solid var(--rr-border)',
	},
	docTab: {
		width: 54,
		borderRadius: '4px 4px 0 0',
		border: '1px solid var(--rr-border)',
		borderBottom: 'none',
		background: 'var(--rr-bg-surface-alt)',
	},
	content: {
		flex: 1,
		minHeight: 0,
	},
	bottomPanel: {
		height: 52,
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
	debugPanel: {
		width: 76,
		flexShrink: 0,
		borderLeft: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
	statusBar: {
		height: 20,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 8px',
		borderTop: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
	statusDot: {
		width: 6,
		height: 6,
		borderRadius: '50%',
		background: 'var(--rr-color-success)',
	},
	// ── Overlay dialog (drawn only when highlighted) ─────────────────────
	overlayBackdrop: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'color-mix(in srgb, var(--rr-bg-default) 55%, transparent)',
	},
	overlayDialog: {
		width: '58%',
		height: '62%',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
	},
	// ── Highlight treatment + zone label ─────────────────────────────────
	zoneLabel: {
		...commonStyles.labelUppercase,
		position: 'absolute',
		fontSize: 8.5,
		lineHeight: 1,
		padding: '2px 5px',
		borderRadius: 3,
		background: 'var(--rr-color-brand)',
		color: 'var(--rr-bg-default)',
		zIndex: 2,
		whiteSpace: 'nowrap',
	},
};

/** The brand outline mixed onto a highlighted zone's base style. */
const HIGHLIGHT_STYLE: React.CSSProperties = {
	outline: '2px solid var(--rr-color-brand)',
	outlineOffset: -2,
	zIndex: 1,
};

// =============================================================================
// LABELS
// =============================================================================

/** Display label per zone, shown on the highlighted zone(s). */
const ZONE_LABEL: Record<FrameZone, string> = {
	sidebar: 'Sidebar',
	sidebarHeader: 'Header',
	sidebarSlot: 'App slot',
	sidebarFooter: 'Footer',
	docTabs: 'DocTabs',
	content: 'Client area',
	bottomPanel: 'Bottom panel',
	statusBar: 'StatusBar',
	debugPanel: 'Debug',
	overlay: 'Overlay',
};

/** The zones labeled in map mode (empty highlight): the default frame. */
const MAP_ZONES: FrameZone[] = ['sidebar', 'docTabs', 'content', 'statusBar'];

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the shell-frame miniature with the requested zone(s) highlighted.
 *
 * Steps: normalize the highlight prop to a set (empty = map mode, labeling
 * every default-frame zone with no outlines); derive each zone's style by
 * mixing the brand outline onto highlighted zones; draw the frame — sidebar
 * column (header / slot / footer) and the main column (doc tabs, content,
 * status bar). The bottom panel, right-docked debug panel, and overlay
 * dialog are NOT part of the default frame and are drawn only when they are
 * the highlighted subject.
 */
export const FrameSchematic: React.FC<IFrameSchematicProps> = ({ highlight }) => {
	// Normalize to a set for O(1) zone checks; empty set = map mode
	const highlighted = new Set<FrameZone>(Array.isArray(highlight) ? highlight : [highlight]);
	const mapMode = highlighted.size === 0;

	/** Mixes the highlight outline onto a zone's base style when selected. */
	const zone = (name: FrameZone, base: React.CSSProperties): React.CSSProperties =>
		highlighted.has(name) ? { ...base, ...HIGHLIGHT_STYLE, position: 'relative' } : base;

	/** Renders the floating label chip for a highlighted (or map-mode) zone. */
	const label = (name: FrameZone, pos: React.CSSProperties): React.ReactNode =>
		highlighted.has(name) || (mapMode && MAP_ZONES.includes(name))
			? <span style={{ ...styles.zoneLabel, ...pos }}>{ZONE_LABEL[name]}</span>
			: null;

	return (
		<div style={styles.frame}>
			{/* Sidebar column: fixed header, scrolling app slot, fixed footer */}
			<div style={{ ...zone('sidebar', styles.sidebar), position: 'relative' }}>
				{label('sidebar', { top: 4, left: 4 })}
				<div style={{ ...zone('sidebarHeader', styles.sidebarHeader), position: 'relative' }}>
					{label('sidebarHeader', { top: 4, left: 4 })}
				</div>
				<div style={{ ...zone('sidebarSlot', styles.sidebarSlot), position: 'relative' }}>
					{label('sidebarSlot', { top: 4, left: 4 })}
					<span style={styles.sidebarLine} />
					<span style={{ ...styles.sidebarLine, width: '70%' }} />
					<span style={{ ...styles.sidebarLine, width: '85%' }} />
					<span style={{ ...styles.sidebarLine, width: '60%' }} />
				</div>
				<div style={{ ...zone('sidebarFooter', styles.sidebarFooter), position: 'relative' }}>
					{label('sidebarFooter', { bottom: 4, left: 4 })}
				</div>
			</div>

			{/* Main column: doc tabs over the client area, then the status bar */}
			<div style={styles.main}>
				<div style={{ ...zone('docTabs', styles.docTabs), position: 'relative' }}>
					{label('docTabs', { top: 3, right: 6 })}
					<span style={{ ...styles.docTab, background: 'var(--rr-bg-default)' }} />
					<span style={styles.docTab} />
					<span style={styles.docTab} />
				</div>
				<div style={{ ...zone('content', styles.content), position: 'relative' }}>
					{label('content', { top: 6, right: 6 })}
				</div>

				{/* Bottom panel — only drawn when it is the subject */}
				{highlighted.has('bottomPanel') && (
					<div style={{ ...zone('bottomPanel', styles.bottomPanel), position: 'relative' }}>
						{label('bottomPanel', { top: 4, right: 6 })}
					</div>
				)}

				<div style={{ ...zone('statusBar', styles.statusBar), position: 'relative' }}>
					{label('statusBar', { top: 3, right: 6 })}
					<span style={styles.statusDot} />
				</div>

				{/* Overlay dialog — only drawn when the overlay zone is the subject */}
				{highlighted.has('overlay') && (
					<div style={styles.overlayBackdrop}>
						<div style={{ ...styles.overlayDialog, ...HIGHLIGHT_STYLE, position: 'relative' }}>
							{label('overlay', { top: 4, left: 4 })}
						</div>
					</div>
				)}
			</div>

			{/* Right-docked ALT+D debug panel — only drawn when it is the subject */}
			{highlighted.has('debugPanel') && (
				<div style={{ ...zone('debugPanel', styles.debugPanel), position: 'relative' }}>
					{label('debugPanel', { top: 4, right: 4 })}
				</div>
			)}
		</div>
	);
};
