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
// DEVELOP VIEW — one workspace, pill-switched panes
// =============================================================================

/**
 * The DEVELOP view: `Preview | Code | Components | Events | Console | Errors`
 * as pill-switched panes of ONE workspace (the Status-screen idiom — pills
 * switch the lens, never the context: the dev session, watch state, and
 * accumulated feeds persist across pane switches). Components is the one
 * deliberate stretch of that idiom: a stateless reference pane (the stock
 * component gallery) rather than a lens on the session.
 *
 * Host differences ride the capability flags: the Code pill exists only
 * when `hasCodePane` (web); the native-files strip renders only when
 * `hasNativeFiles` (VSCode); Debug only when `canDebug`. The preview and
 * code surfaces themselves are HOST-PROVIDED slots — this view owns the
 * chrome (toolbar, DEV badge, pills) and the feed panes.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ToggleGroup } from '../../components/toggle-group/ToggleGroup';
import { ComponentGallery } from './gallery';
import { LogList, LOG_LIST_CAP } from './LogList';
import type { LogListRow } from './LogList';
import type { AppErrorRow, AppEventRow, ConsoleRow, DevelopPane, IAppBuilderHost, WatchStatus } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DevelopView} component. */
export interface IDevelopViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The live preview surface (host-owned iframe wrapper). */
	previewPane?: React.ReactNode;
	/** The Code pane surface (web host: file tree + Monaco). */
	codePane?: React.ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	pillRow: {
		padding: '12px 14px 10px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	},
	// No bottom border: the toolbar and the preview surface below share one
	// continuous background — the CRT bezel floats on it.
	toolbar: {
		height: 39,
		background: 'var(--rr-bg-widget)',
		display: 'flex',
		alignItems: 'center',
		padding: '5px 10px 0',
		gap: 8,
		flexShrink: 0,
		fontSize: 12,
	},
	toolbarUrl: {
		flex: 1,
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '4px 10px',
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	toolBtn: {
		padding: '4px 9px',
		background: 'transparent',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		color: 'var(--rr-text-secondary)',
		fontSize: 11.5,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	toolBtnOn: {
		borderColor: 'var(--rr-color-secondary)',
		color: 'var(--rr-color-secondary)',
	},
	inheritAuth: {
		display: 'flex',
		alignItems: 'center',
		gap: 5,
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
		cursor: 'pointer',
		userSelect: 'none',
	},
	inheritAuthBox: {
		accentColor: 'var(--rr-brand)',
		cursor: 'pointer',
		margin: 0,
	},
	logToolbar: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 6,
		padding: '8px 10px 0',
		flexShrink: 0,
	},
	paneHost: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		position: 'relative',
	},
	previewSurface: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
		// Same surface as the toolbar above — one continuous field around
		// the CRT bezel instead of a white gutter.
		background: 'var(--rr-bg-widget)',
	},
	// CRT-tube framing: a grayish bezel with generous rounding around the
	// preview, the "glass" clipped inside it so the app's corners round too.
	previewBezel: {
		flex: 1,
		minHeight: 0,
		margin: '10px 12px 12px',
		padding: 10,
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 18,
		boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.14)',
		display: 'flex',
		flexDirection: 'column',
	},
	previewScreen: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
		borderRadius: 10,
		overflow: 'hidden',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-default)',
	},
	devBadge: {
		position: 'absolute',
		top: 10,
		right: 12,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-brand)',
		borderRadius: 4,
		padding: '5px 10px',
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 10.5,
		zIndex: 5,
		lineHeight: 1.5,
		boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
		color: 'var(--rr-text-secondary)',
	},
	devBadgeBrand: {
		color: 'var(--rr-brand)',
		fontWeight: 700,
	},
	devBadgeOk: {
		color: 'var(--rr-color-success)',
	},
	devBadgeErr: {
		color: 'var(--rr-color-error)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the DEVELOP workspace.
 *
 * @param props - See {@link IDevelopViewProps}.
 */
export const DevelopView: React.FC<IDevelopViewProps> = ({ host, previewPane, codePane }) => {
	const caps = host.capabilities;

	// ── Pane state — the active lens ─────────────────────────────────────
	const [pane, setPane] = useState<DevelopPane>('preview');
	const [previewTheme, setPreviewTheme] = useState<'light' | 'dark'>('light');
	// Inherit Auth: hand the host's session to the preview (default) or make
	// the preview run its own OAuth cycle.
	const [inheritAuth, setInheritAuth] = useState(true);

	// ── Components pane — mounted on first visit, then kept mounted so the
	//    selected entry and knob values survive pill switches ──────────────
	const [galleryMounted, setGalleryMounted] = useState(false);

	// ── ONE merged log — console output, errors, and events interleaved in
	//    arrival order (persists across pane switches). Errors and events
	//    are console ROWS, not separate pages: red accents for errors,
	//    info accents for events.
	const [logRows, setLogRows] = useState<LogListRow[]>([]);
	const appendRow = React.useCallback((row: LogListRow): void => {
		setLogRows((prev) => {
			const next = [...prev, row];
			return next.length > LOG_LIST_CAP ? next.slice(next.length - LOG_LIST_CAP) : next;
		});
	}, []);
	useEffect(() => host.subscribeConsole?.((c: ConsoleRow) => appendRow({
		time: c.time,
		accent: c.level,
		accentColor: c.level === 'error' ? 'var(--rr-color-error)' : c.level === 'warn' ? 'var(--rr-color-warning)' : 'var(--rr-color-info)',
		detail: c.text,
	})), [host.subscribeConsole, appendRow]);
	useEffect(() => host.subscribeErrors?.((e: AppErrorRow) => appendRow({
		time: e.time,
		accent: e.source ?? 'error',
		accentColor: 'var(--rr-color-error)',
		detail: e.message,
	})), [host.subscribeErrors, appendRow]);
	useEffect(() => host.subscribeEvents?.((ev: AppEventRow) => appendRow({
		time: ev.time,
		accent: ev.name,
		accentColor: 'var(--rr-color-info)',
		detail: ev.payload,
	})), [host.subscribeEvents, appendRow]);

	/** Copies the whole log as plain text. */
	const copyLog = (): void => {
		const text = logRows.map((r) => `${r.time}  ${r.accent}  ${r.detail ?? ''}`).join('\n');
		try {
			void navigator.clipboard.writeText(text);
		} catch { /* clipboard unavailable in this webview — nothing to do */ }
	};

	// ── Watch/build status for the DEV badge ─────────────────────────────
	const [watch, setWatch] = useState<WatchStatus | null>(null);
	useEffect(() => host.subscribeWatch?.((s) => setWatch(s)), [host.subscribeWatch]);

	// ── Pill menu — Code only where the host has a Code pane. Errors and
	//    events fold into Console (one log), so no pills of their own.
	const pillOptions = useMemo(() => {
		const options: Array<{ id: DevelopPane; label: string }> = [{ id: 'preview', label: 'Preview' }];
		if (caps.hasCodePane) options.push({ id: 'code', label: 'Code' });
		options.push({ id: 'components', label: 'Components' }, { id: 'console', label: 'Console' });
		return options;
	}, [caps.hasCodePane]);

	/** Switch panes, mounting the Components gallery on its first visit. */
	const selectPane = (id: DevelopPane): void => {
		setPane(id);
		if (id === 'components') setGalleryMounted(true);
	};

	/** Theme toggle: update local toolbar state and tell the host. */
	const applyTheme = (theme: 'light' | 'dark'): void => {
		setPreviewTheme(theme);
		host.setPreviewTheme?.(theme);
	};

	return (
		<div style={styles.wrap}>
			{/* Pill row — the lens switcher */}
			<div style={styles.pillRow}>
				<ToggleGroup options={pillOptions} value={pane} onChange={selectPane} />
			</div>


			{/* PANE: PREVIEW — toolbar + host slot + DEV badge. KEPT MOUNTED
			    while other panes are active: the preview iframe is a running
			    shell + dev session — unmounting it on every pill switch
			    reboots the whole preview (and its HMR client) for nothing. */}
			{previewPane && (
				<div style={{ ...styles.paneHost, display: pane === 'preview' ? 'flex' : 'none' }}>
					<div style={styles.toolbar}>
						<div style={styles.toolbarUrl}>{host.getPreviewUrl?.() ?? ''}</div>
					{host.setInheritAuth && (
							<label style={styles.inheritAuth} title="Hand this window's signed-in session to the preview. Unchecked: the preview runs its own OAuth sign-in.">
								<input
									type="checkbox"
									checked={inheritAuth}
									onChange={(e) => {
										setInheritAuth(e.target.checked);
										host.setInheritAuth?.(e.target.checked);
									}}
									style={styles.inheritAuthBox}
								/>
								Inherit Auth
							</label>
						)}
						{host.reloadPreview && (
							<button style={styles.toolBtn} onClick={() => host.reloadPreview?.()}>Reload</button>
						)}
						{host.setPreviewTheme && (
							<>
								<button
									style={previewTheme === 'light' ? { ...styles.toolBtn, ...styles.toolBtnOn } : styles.toolBtn}
									onClick={() => applyTheme('light')}
								>Light</button>
								<button
									style={previewTheme === 'dark' ? { ...styles.toolBtn, ...styles.toolBtnOn } : styles.toolBtn}
									onClick={() => applyTheme('dark')}
								>Dark</button>
							</>
						)}
						{caps.canDebug && host.debug && (
							<button style={styles.toolBtn} onClick={() => host.debug?.()}>Debug (F5)</button>
						)}
					</div>
					<div style={styles.previewSurface}>
						{watch && watch.state !== 'idle' && (
							<div style={styles.devBadge}>
								<span style={styles.devBadgeBrand}>DEV</span>
								{watch.target ? ` → ${watch.target}` : ''}
								<br />
								<span style={watch.state === 'error' ? styles.devBadgeErr : styles.devBadgeOk}>
									watch: {watch.state}
									{watch.durationMs != null ? ` · ${(watch.durationMs / 1000).toFixed(1)}s` : ''}
								</span>
							</div>
						)}
						<div style={styles.previewBezel}>
							<div style={styles.previewScreen}>{previewPane}</div>
						</div>
					</div>
				</div>
			)}

			{/* PANE: CODE — host slot (web only). KEPT MOUNTED while other
			    panes are active: the compiler/linker live inside it, and the
			    preview needs the project compiled without ever visiting the
			    Code pill (RocketApp's keep-editors-mounted pattern). */}
			{caps.hasCodePane && (
				<div style={{ ...styles.paneHost, display: pane === 'code' ? 'flex' : 'none' }}>{codePane}</div>
			)}

			{/* PANE: COMPONENTS — the stock component gallery. Mounted on
			    first visit, then KEPT MOUNTED (display:none) so the selected
			    entry and knob values survive pill switches. Static reference
			    content: no session state, works identically in both hosts. */}
			{galleryMounted && (
				<div style={{ ...styles.paneHost, display: pane === 'components' ? 'flex' : 'none' }}>
					<ComponentGallery />
				</div>
			)}

			{/* PANE: CONSOLE — the ONE log: console output, errors (red), and
			    platform events (info), interleaved in arrival order. */}
			{pane === 'console' && (
				<div style={styles.paneHost}>
					<div style={styles.logToolbar}>
						<button style={styles.toolBtn} onClick={() => setLogRows([])}>Clear</button>
						<button style={styles.toolBtn} onClick={copyLog}>Copy</button>
					</div>
					<LogList
						rows={logRows}
						emptyTitle="No output yet"
						emptyDescription="Everything lands here as the app runs — console.log / warn / error from the preview, runtime and build errors, and shell platform events."
					/>
				</div>
			)}
		</div>
	);
};
