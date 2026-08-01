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
 * The DEVELOP view: `Preview | Code | Events | Console | Errors` as
 * pill-switched panes of ONE workspace (the Status-screen idiom — pills
 * switch the lens, never the context: the dev session, watch state, and
 * accumulated feeds persist across pane switches).
 *
 * Host differences ride the capability flags: the Code pill exists only
 * when `hasCodePane` (web); the native-files strip renders only when
 * `hasNativeFiles` (VSCode); Debug only when `canDebug`. The preview and
 * code surfaces themselves are HOST-PROVIDED slots — this view owns the
 * chrome (toolbar, DEV badge, pills) and the feed panes.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ToggleGroup } from '../../components/toggle-group/ToggleGroup';
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
	nativeFiles: {
		display: 'flex',
		alignItems: 'center',
		gap: 9,
		padding: '7px 14px',
		borderBottom: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-surface-alt)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	},
	nativeFilesLink: {
		color: 'var(--rr-text-link)',
		cursor: 'pointer',
	},
	toolbar: {
		height: 34,
		background: 'var(--rr-bg-widget)',
		borderBottom: '1px solid var(--rr-border)',
		display: 'flex',
		alignItems: 'center',
		padding: '0 10px',
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
// FEED ACCUMULATION HOOK
// =============================================================================

/**
 * Subscribes to one host feed and accumulates rows with the shared cap.
 * Steps: subscribe on mount (when the host implements the feed), append
 * each row, trim to the cap, unsubscribe on unmount.
 *
 * @param subscribe - The host's subscribe method for this feed, if any.
 * @returns Accumulated rows, oldest first.
 */
function useFeed<T>(subscribe: ((listener: (row: T) => void) => () => void) | undefined): T[] {
	const [rows, setRows] = useState<T[]>([]);
	useEffect(() => {
		if (!subscribe) return;
		return subscribe((row) => {
			setRows((prev) => {
				const next = [...prev, row];
				return next.length > LOG_LIST_CAP ? next.slice(next.length - LOG_LIST_CAP) : next;
			});
		});
	}, [subscribe]);
	return rows;
}

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

	// ── Feeds — persist across pane switches (accumulated here) ──────────
	const events = useFeed<AppEventRow>(host.subscribeEvents);
	const consoleRows = useFeed<ConsoleRow>(host.subscribeConsole);
	const errors = useFeed<AppErrorRow>(host.subscribeErrors);

	// ── Watch/build status for the DEV badge ─────────────────────────────
	const [watch, setWatch] = useState<WatchStatus | null>(null);
	useEffect(() => host.subscribeWatch?.((s) => setWatch(s)), [host.subscribeWatch]);

	// ── Pill menu — Code only where the host has a Code pane ─────────────
	const pillOptions = useMemo(() => {
		const options: Array<{ id: DevelopPane; label: string }> = [{ id: 'preview', label: 'Preview' }];
		if (caps.hasCodePane) options.push({ id: 'code', label: 'Code' });
		options.push({ id: 'events', label: 'Events' }, { id: 'console', label: 'Console' }, { id: 'errors', label: 'Errors' });
		return options;
	}, [caps.hasCodePane]);

	// ── Feed rows → shared LogList shape ─────────────────────────────────
	const eventRows: LogListRow[] = useMemo(() =>
		events.map((e) => ({ time: e.time, accent: e.name, detail: e.payload })), [events]);
	const consoleListRows: LogListRow[] = useMemo(() =>
		consoleRows.map((c) => ({
			time: c.time,
			accent: c.level,
			accentColor: c.level === 'error' ? 'var(--rr-color-error)' : c.level === 'warn' ? 'var(--rr-color-warning)' : 'var(--rr-color-info)',
			detail: c.text,
		})), [consoleRows]);
	const errorRows: LogListRow[] = useMemo(() =>
		errors.map((e) => ({
			time: e.time,
			accent: e.source ?? 'error',
			accentColor: 'var(--rr-color-error)',
			detail: e.message,
		})), [errors]);

	/** Theme toggle: update local toolbar state and tell the host. */
	const applyTheme = (theme: 'light' | 'dark'): void => {
		setPreviewTheme(theme);
		host.setPreviewTheme?.(theme);
	};

	return (
		<div style={styles.wrap}>
			{/* Pill row — the lens switcher */}
			<div style={styles.pillRow}>
				<ToggleGroup options={pillOptions} value={pane} onChange={(id) => setPane(id)} />
			</div>

			{/* VSCode: files are native — bind, don't sync */}
			{caps.hasNativeFiles && (
				<div style={styles.nativeFiles}>
					<span>Files live in your workspace — edit in the editor; watch rebuilds on save.</span>
					{host.revealFiles && (
						<span style={styles.nativeFilesLink} onClick={() => host.revealFiles?.()}>Reveal in Explorer</span>
					)}
				</div>
			)}

			{/* PANE: PREVIEW — toolbar + host slot + DEV badge */}
			{pane === 'preview' && (
				<div style={styles.paneHost}>
					<div style={styles.toolbar}>
						<div style={styles.toolbarUrl}>{host.getPreviewUrl?.() ?? ''}</div>
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

			{/* PANE: EVENTS */}
			{pane === 'events' && (
				<LogList
					rows={eventRows}
					emptyTitle="No events yet"
					emptyDescription="Shell and platform events land here as the app runs — connect, switch, theme, manifest refreshes."
				/>
			)}

			{/* PANE: CONSOLE */}
			{pane === 'console' && (
				<LogList
					rows={consoleListRows}
					emptyTitle="No console output"
					emptyDescription="The app's console.log / warn / error output is mirrored here from the preview."
				/>
			)}

			{/* PANE: ERRORS */}
			{pane === 'errors' && (
				<LogList
					rows={errorRows}
					emptyTitle="No errors"
					emptyDescription="Runtime errors thrown by the app, failed client calls, and bundle load failures land here — each opening the offending source line."
				/>
			)}
		</div>
	);
};
