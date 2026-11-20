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
// VECTOR-UI — ExportMenu (CSV, JSON and PNG of what is on screen)
// =============================================================================
//
// A menu of the host's export items: each one's rows (CSV with RFC 4180
// quoting and a guard for cells starting with = + - @, or JSON with
// schema_version 1) or picture (PNG), built only when chosen and handed to
// the browser as a download named
// vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext>. Nothing is sent
// anywhere; exports never carry vectors, tokens, hosts or node settings
// (vector/export.ts cleanRows).
//
// A real menu (WAI-ARIA menu button): the button has aria-haspopup="menu";
// opening it (click, Enter, Space, Arrow Down/Up) moves focus to the first
// choice; the arrow keys, Home and End move between choices, Escape closes
// and returns focus to the button, Tab closes. One group per item, one menu
// item per format (CSV and JSON for rows, PNG for the picture). The panel is
// placed before it is painted, inside the viewport (AdvancedPopover.tsx
// usePopover), and closes on a window resize (focus back on the button) or a
// pointer pressed outside it. Escape is marked handled (preventDefault), never
// stopped.
//
// States: nothing to export (the button is disabled with "Nothing to
// export"); an item the host disabled (its reason, e.g. "Nothing selected" or
// "The map is not drawn right now."); a large export (more than 20,000 rows:
// "Preparing N of M rows…" with Cancel); a refused download ("Your browser
// blocked the download."); done ("Saved <file> (N rows).").
//
// The hosts build their items with vector/export.ts (mapExportItems,
// documentExportItems, searchExportItems, retrievalExportItems) and
// map/exportPng.ts (mapPngItem). exportNow runs one item without the menu
// (the Clusters tab's and the similarity matrix's Export buttons).
//
// Lane hooks: the root carries data-component="ExportMenu"; every entry
// carries data-export-item="<id>" and its buttons data-export-format.
// =============================================================================

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ExportMenuProps, IExportItem } from '../contract/types';
import { MAP_STYLES } from '../map/styles';
import { POPOVER_PANEL, usePopover } from './AdvancedPopover';
import { COPY_BLOCKED_SENTENCE, copyLabel, outcomeSentence, progressSentence, runExport } from '../vector/export';
import type { ExportFormat, ExportOutcome } from '../vector/export';

export type { ExportMenuProps };

/** The button's words when the host gives none. */
const DEFAULT_LABEL = 'Export';

/** The disabled button's reason when the host has no items. */
const NOTHING_TO_EXPORT = 'Nothing to export';

/** How long the object URL lives after the click (revoking at once can cancel a slow download). */
const REVOKE_AFTER_MS = 10_000;

/**
 * Hand a file to the browser as a download (an attached anchor with `download`).
 *
 * @param blob - The file.
 * @param name - Its name.
 * @returns False when the browser cannot or did not take it.
 */
export function browserDownload(blob: Blob, name: string): boolean {
	try {
		if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
		const anchor = document.createElement('a');
		if (!('download' in anchor)) return false;
		const url = URL.createObjectURL(blob);
		anchor.href = url;
		anchor.download = name;
		anchor.rel = 'noopener';
		anchor.style.display = 'none';
		document.body.appendChild(anchor);
		anchor.click();
		document.body.removeChild(anchor);
		setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
		return true;
	} catch {
		return false;
	}
}

/**
 * Export one item straight away (no menu): the Clusters tab's and the matrix's Export buttons.
 *
 * @param item - The item.
 * @param format - csv, json or png.
 * @param collection - For the file name.
 * @returns What happened (outcomeSentence words it).
 */
export function exportNow(item: IExportItem, format: ExportFormat, collection: string | null): Promise<ExportOutcome> {
	return runExport(item, format, { collection, download: browserDownload });
}

/** The width a menu panel is laid out for, CSS pixels (for choosing its side). */
export const EXPORT_PANEL_WIDTH = 320;

/**
 * Which edge of its button a popover hangs from: the left edge when the panel
 * fits to the right of it, else the right edge when it fits to the left, else
 * the side with more room (the panel is also capped at the viewport's width).
 *
 * @param buttonLeft - The button's left edge, CSS pixels from the viewport's.
 * @param buttonRight - Its right edge.
 * @param viewportWidth - window.innerWidth.
 * @param panelWidth - The panel's width.
 * @returns 'left' (panel starts at the button's left edge) or 'right' (ends at its right edge).
 */
export function popoverSide(buttonLeft: number, buttonRight: number, viewportWidth: number, panelWidth: number): 'left' | 'right' {
	const margin = 8;
	if (buttonLeft + panelWidth <= viewportWidth - margin) return 'left';
	if (buttonRight - panelWidth >= margin) return 'right';
	return viewportWidth - buttonLeft >= buttonRight ? 'left' : 'right';
}

/**
 * The side a popover anchored in `root` should open on now.
 *
 * @param root - The menu's root element.
 * @param panelWidth - The panel's width.
 * @returns The side ('right' outside a browser).
 */
export function sideFor(root: HTMLElement | null, panelWidth: number): 'left' | 'right' {
	if (!root || typeof window === 'undefined') return 'right';
	const rect = root.getBoundingClientRect();
	return popoverSide(rect.left, rect.right, window.innerWidth, panelWidth);
}

/**
 * The anchoring style of a popover on its side.
 *
 * @param side - 'left' or 'right'.
 * @returns left/right offsets and a width cap.
 */
export function sideStyle(side: 'left' | 'right'): React.CSSProperties {
	return side === 'left' ? { left: 0, right: 'auto', maxWidth: 'calc(100vw - 16px)' } : { right: 0, left: 'auto', maxWidth: 'calc(100vw - 16px)' };
}

/** The formats an item offers: PNG for a picture, CSV and JSON for rows. */
function formatsOf(item: IExportItem): ExportFormat[] {
	const out: ExportFormat[] = [];
	if (item.rows) out.push('csv', 'json');
	if (item.png) out.push('png');
	if (out.length === 0) out.push(item.kind === 'map' ? 'png' : 'csv');
	return out;
}

/** Props of the open panel (also rendered by the tests). */
export interface ExportMenuPanelProps {
	/** The panel's id (the button's aria-controls). */
	id: string;
	items: readonly IExportItem[];
	/** An export is running: the choices wait (aria-disabled, so focus stays where it is). */
	busy: boolean;
	/** The last outcome's words, or null. */
	status: string | null;
	/** A large export's progress, or null. */
	progress: { done: number; total: number } | null;
	onChoose(item: IExportItem, format: ExportFormat): void;
	onCancel(): void;
	/** Escape or Tab inside the menu: close it and put focus back on its button. */
	onClose?(refocus: boolean): void;
	/** The menu element, for moving focus into it when it opens. */
	menuRef?: React.Ref<HTMLDivElement>;
	/**
	 * Which edge of the button the panel hangs from (default 'right') when nothing places it: a static render. In the
	 * browser usePopover places it before it is painted.
	 */
	side?: 'left' | 'right';
	/** Where it was placed (usePopover), merged last. */
	placement?: React.CSSProperties;
	/** The panel element, for measuring it. */
	panelRef?: React.Ref<HTMLDivElement>;
	/** A refused download of rows: copy it instead (its button's words, and the copy). */
	fallback?: { label: string; onCopy(): void } | null;
	/** The clipboard was refused too: the export to select by hand. */
	copyBlocked?: string | null;
}

/**
 * Where focus moves in a menu of `count` choices on a key (wrapping).
 *
 * @param index - The focused choice (-1: none).
 * @param count - Enabled choices.
 * @param key - The key.
 * @returns The next index, or null when the key does not move focus.
 */
export function stepFocus(index: number, count: number, key: string): number | null {
	if (count <= 0) return null;
	if (key === 'ArrowDown' || key === 'ArrowRight') return index < 0 ? 0 : (index + 1) % count;
	if (key === 'ArrowUp' || key === 'ArrowLeft') return index < 0 ? count - 1 : (index - 1 + count) % count;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	return null;
}

/**
 * The enabled choices of a menu element.
 *
 * @param menu - The role="menu" element.
 * @returns Its menu items that are not disabled.
 */
function enabledChoices(menu: HTMLElement | null): HTMLElement[] {
	return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')) : [];
}

const S = {
	root: { position: 'relative', display: 'inline-flex', alignItems: 'center' } as React.CSSProperties,
	panel: { ...POPOVER_PANEL, top: 'calc(100% + 4px)', minWidth: 300, width: EXPORT_PANEL_WIDTH, padding: 8, border: `1px solid var(--rr-text-primary)` } as React.CSSProperties,
	entry: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 2px', borderBottom: '1px solid var(--rr-border)' } as React.CSSProperties,
	label: { ...MAP_STYLES.small, flex: 1, minWidth: 0 } as React.CSSProperties,
	reason: { ...MAP_STYLES.small, display: 'block', fontStyle: 'italic' } as React.CSSProperties,
	format: { ...MAP_STYLES.button, height: 24, padding: '0 8px', fontSize: 11.5 } as React.CSSProperties,
	status: { ...MAP_STYLES.note, margin: '6px 2px 0' } as React.CSSProperties,
	hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as React.CSSProperties,
	copied: { width: '100%', boxSizing: 'border-box', height: 120, marginTop: 4, resize: 'vertical', fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, color: 'var(--rr-text-primary)', background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border-input)', borderRadius: 4 } as React.CSSProperties,
};

/**
 * The open panel: a menu with one group per item (its format choices, or its
 * reason when disabled), then the progress or the last outcome.
 *
 * @param props - Items, state and handlers.
 * @returns The panel.
 */
export function ExportMenuPanel(props: ExportMenuPanelProps): React.ReactElement {
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		if (event.defaultPrevented) return;
		if (event.key === 'Escape' || event.key === 'Tab') {
			if (event.key === 'Escape') event.preventDefault();
			// Focus goes back to the button either way: Escape stays there, Tab moves on from it.
			props.onClose?.(true);
			return;
		}
		const choices = enabledChoices(event.currentTarget);
		const at = choices.findIndex((el) => el === (typeof document !== 'undefined' ? document.activeElement : null));
		const next = stepFocus(at, choices.length, event.key);
		if (next === null) return;
		event.preventDefault();
		choices[next]?.focus();
	};
	return (
		<div ref={props.panelRef} id={props.id} style={{ ...S.panel, ...sideStyle(props.side ?? 'right'), ...props.placement }} data-export-panel="">
			<div ref={props.menuRef} role="menu" aria-label="Export choices" aria-busy={props.busy || undefined} tabIndex={-1} onKeyDown={onKeyDown}>
				{props.items.map((item, index) => {
					const labelId = `${props.id}-item-${index}`;
					const reasonId = item.disabled ? `${props.id}-why-${index}` : undefined;
					const off = item.disabled !== null;
					return (
						<div key={item.id} role="group" aria-labelledby={labelId} style={S.entry} data-export-item={item.id} data-export-state={off ? 'off' : 'on'}>
							<span style={S.label} aria-hidden="true">
								<span id={labelId}>{item.label}</span>
								{item.disabled ? (
									<span id={reasonId} style={S.reason}>
										{item.disabled}
									</span>
								) : null}
							</span>
							{formatsOf(item).map((format) => (
								<button
									key={format}
									type="button"
									role="menuitem"
									tabIndex={-1}
									style={{ ...S.format, ...(off || props.busy ? MAP_STYLES.buttonDisabled : null) }}
									disabled={off}
									aria-disabled={props.busy || undefined}
									data-export-format={format}
									aria-label={`${item.label} as ${format.toUpperCase()}`}
									aria-describedby={reasonId}
									onClick={() => {
										if (!props.busy) props.onChoose(item, format);
									}}
								>
									{format.toUpperCase()}
								</button>
							))}
						</div>
					);
				})}
			</div>
			{props.progress ? (
				<p style={{ ...S.status, display: 'flex', alignItems: 'center', gap: 8 }}>
					<span role="status">{progressSentence(props.progress.done, props.progress.total)}</span>
					<button type="button" style={S.format} onClick={props.onCancel} data-export-cancel="">
						Cancel
					</button>
				</p>
			) : (
				<p role="status" style={S.status} data-export-status="">
					{props.status ?? ''}
				</p>
			)}
			{props.fallback ? (
				<p style={S.status}>
					<button type="button" style={S.format} onClick={props.fallback.onCopy} data-export-copy="">
						{props.fallback.label}
					</button>
				</p>
			) : null}
			{props.copyBlocked != null ? (
				<div data-export-copy-blocked="">
					<p style={S.status}>{COPY_BLOCKED_SENTENCE}</p>
					<textarea readOnly value={props.copyBlocked} aria-label="The export, to select and copy" style={S.copied} />
				</div>
			) : null}
		</div>
	);
}

/**
 * The export menu.
 *
 * @param props - The host's items and collection (frozen props).
 * @returns The button and, when open, its menu.
 */
export function ExportMenu(props: ExportMenuProps): React.ReactElement {
	const label = props.label ?? DEFAULT_LABEL;
	const panelId = `export-${useId().replace(/:/g, '')}`;
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
	// A refused download of rows (a dev-tool mount's webview may refuse them): its text, to copy instead.
	const [fallback, setFallback] = useState<{ format: 'csv' | 'json'; text: string; fileName: string } | null>(null);
	const [copyBlocked, setCopyBlocked] = useState<string | null>(null);
	const abort = useRef<{ aborted: boolean } | null>(null);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const live = useRef(true);
	const empty = props.items.length === 0;

	// Opening moves focus to the first choice (or the menu when every choice is disabled).
	useEffect(() => {
		if (!open) return;
		const first = enabledChoices(menu.current)[0];
		(first ?? menu.current)?.focus();
	}, [open]);

	// A host whose items all went away closes the menu.
	useEffect(() => {
		if (empty && open) setOpen(false);
	}, [empty, open]);

	// A host that unmounts mid-export stops it.
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			if (abort.current) abort.current.aborted = true;
		};
	}, []);

	// Copy a refused download instead; when the clipboard is refused too, show the text to select by hand.
	const copyExport = (copy: { format: 'csv' | 'json'; text: string; fileName: string }): void => {
		const refused = (): void => {
			if (!live.current) return;
			setFallback(null);
			setCopyBlocked(copy.text);
		};
		const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
		if (!clipboard) {
			refused();
			return;
		}
		clipboard.writeText(copy.text).then(() => {
			if (!live.current) return;
			setFallback(null);
			setStatus(`Copied ${copy.fileName} as ${copy.format.toUpperCase()}.`);
		}, refused);
	};

	const close = useCallback((refocus: boolean): void => {
		setOpen(false);
		if (refocus) button.current?.focus();
	}, []);
	// Placed inside the viewport before paint; a resize or a press outside closes it.
	const placement = usePopover(open && !empty, { root, trigger: button, panel }, close);

	const choose = useCallback(
		(item: IExportItem, format: ExportFormat): void => {
			const signal = { aborted: false };
			abort.current = signal;
			setBusy(true);
			setStatus(null);
			setProgress(null);
			setFallback(null);
			setCopyBlocked(null);
			void runExport(item, format, { collection: props.collection, download: browserDownload, signal, onProgress: (done, total) => live.current && setProgress({ done, total }) }).then((outcome) => {
				if (abort.current === signal) abort.current = null;
				if (!live.current) return;
				setBusy(false);
				setProgress(null);
				setStatus(outcomeSentence(outcome));
				if (outcome.status === 'blocked' && outcome.copy) setFallback({ ...outcome.copy, fileName: outcome.fileName });
				if (outcome.status === 'done') props.onExported?.(outcome.fileName);
			});
		},
		[props]
	);

	return (
		<span ref={root} role="group" aria-label={label} data-component="ExportMenu" data-export-busy={busy ? '' : undefined} style={S.root}>
			<button
				ref={button}
				type="button"
				style={{ ...MAP_STYLES.button, ...(empty ? MAP_STYLES.buttonDisabled : null) }}
				disabled={empty}
				title={empty ? NOTHING_TO_EXPORT : undefined}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(event) => {
					if (event.defaultPrevented) return;
					if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
						event.preventDefault();
						setOpen(true);
					} else if (event.key === 'Escape' && open) {
						event.preventDefault();
						setOpen(false);
					}
				}}
			>
				{label} ▾
			</button>
			{open && !empty ? (
				<ExportMenuPanel
					id={panelId}
					menuRef={menu}
					panelRef={panel}
					placement={placement}
					items={props.items}
					busy={busy}
					status={status}
					progress={progress}
					onChoose={choose}
					onClose={close}
					onCancel={() => {
						if (abort.current) abort.current.aborted = true;
					}}
					fallback={fallback ? { label: copyLabel(fallback.format), onCopy: () => copyExport(fallback) } : null}
					copyBlocked={copyBlocked}
				/>
			) : null}
			{!open && status ? (
				<span role="status" style={S.hidden}>
					{status}
				</span>
			) : null}
		</span>
	);
}

export default ExportMenu;
