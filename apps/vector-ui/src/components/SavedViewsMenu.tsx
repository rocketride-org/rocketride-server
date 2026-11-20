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
// VECTOR-UI — SavedViewsMenu (the map toolbar's Views menu)
// =============================================================================
//
// Save the current view under a name, list, apply and delete views of this
// connection (in memory, at most 20, gone on sign-out). Applying draws the
// sample again with the view's seed and scope and restores its selection
// by key; never a token or a vector is kept (vector/savedViews.ts).
//
// The views live in the 'saved views' cache of adapters/connections.ts, keyed
// by the connection: switching to another connection and back lists them
// again, and the identity change (sign-out, another user) empties the cache
// through the registry. Nothing is written anywhere else.
//
// States: no sample (Save says "Draw a sample first."); twenty views (Save is
// disabled with the sentence); none saved ("No saved views yet."); applying
// ("Applying <name>…", the buttons wait); applied (the restore line, e.g.
// "1,340 of 1,900 selected points restored; 200 drawn hollow; 360 dropped");
// failed ("The view could not be applied."). The footer says what a view
// keeps of a selection. The text query is never run again on its own.
//
// Lane hooks: the root carries data-component="SavedViewsMenu"; each listed
// view data-view-id; the status line data-views-status.
// =============================================================================

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { savedViews } from '../adapters/connections';
import type { ISavedView, IVectorLimits, SavedViewsMenuProps } from '../contract/types';
import { MAP_STYLES } from '../map/styles';
import { sideFor, sideStyle } from './ExportMenu';
import { VIEW_NAME_MAX, defaultViewName, deleteView, keepSentence, listViews, newViewId, restoreSentence, saveBlocker, saveView, viewSummary } from '../vector/savedViews';

export type { SavedViewsMenuProps };

/** The panel's width, CSS pixels. */
const VIEWS_PANEL_WIDTH = 360;

/** A failed apply. */
const APPLY_FAILED = 'The view could not be applied.';

/** Said after applying a view that has a text query. */
const QUERY_NOT_RUN = 'Its text query is not run again on its own (it costs an embed call).';

/** Props of the open panel (also rendered by the tests). */
export interface SavedViewsPanelProps {
	/** The panel's id (the button's aria-controls). */
	id: string;
	limits: IVectorLimits;
	views: readonly ISavedView[];
	/** The name field. */
	name: string;
	/** The view being applied, or null. */
	busyId: string | null;
	status: string | null;
	/** Why Save is off (twenty views), or null. */
	saveDisabled: string | null;
	onName(name: string): void;
	onSave(): void;
	onApply(view: ISavedView): void;
	onDelete(view: ISavedView): void;
	/** The name field, for moving focus into it when the menu opens. */
	nameRef?: React.Ref<HTMLInputElement>;
	/** Which edge of the button the panel hangs from (default 'right'). */
	side?: 'left' | 'right';
}

const S = {
	root: { position: 'relative', display: 'inline-flex', alignItems: 'center' } as React.CSSProperties,
	panel: { position: 'absolute', top: 'calc(100% + 4px)', zIndex: 20, width: VIEWS_PANEL_WIDTH, boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', color: 'var(--rr-text-primary)', boxShadow: '0 4px 16px rgba(0,0,0,0.25)' } as React.CSSProperties,
	save: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } as React.CSSProperties,
	input: { ...MAP_STYLES.input, minWidth: 0, flex: 1 } as React.CSSProperties,
	entry: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderBottom: '1px solid var(--rr-border)' } as React.CSSProperties,
	words: { flex: 1, minWidth: 0 } as React.CSSProperties,
	name: { ...MAP_STYLES.small, fontWeight: 700, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as React.CSSProperties,
	summary: { ...MAP_STYLES.small, display: 'block' } as React.CSSProperties,
	small: { ...MAP_STYLES.button, height: 24, padding: '0 8px', fontSize: 11.5 } as React.CSSProperties,
	note: { ...MAP_STYLES.note, margin: '6px 0 0' } as React.CSSProperties,
	hidden: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as React.CSSProperties,
};

/**
 * Hours and minutes of a save.
 *
 * @param at - Epoch ms.
 * @returns 'hh:mm' in local time.
 */
function savedAt(at: number): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The open panel: Save, the list, the footer and the status line.
 *
 * @param props - Views, state and handlers.
 * @returns The panel.
 */
export function SavedViewsPanel(props: SavedViewsPanelProps): React.ReactElement {
	const busy = props.busyId !== null;
	const saveOff = props.saveDisabled !== null || busy;
	return (
		<div id={props.id} role="group" aria-label="Saved views" style={{ ...S.panel, ...sideStyle(props.side ?? 'right') }} data-views-panel="">
			<form
				style={S.save}
				onSubmit={(event) => {
					event.preventDefault();
					if (!saveOff) props.onSave();
				}}
			>
				<input ref={props.nameRef} type="text" style={S.input} aria-label="View name" maxLength={VIEW_NAME_MAX} placeholder={defaultViewName(props.views)} value={props.name} onChange={(event) => props.onName(event.target.value)} />
				<button type="submit" style={{ ...MAP_STYLES.button, ...(saveOff ? MAP_STYLES.buttonDisabled : null) }} disabled={saveOff} title={props.saveDisabled ?? 'Save the current view'} data-views-save="">
					Save
				</button>
			</form>
			{props.saveDisabled ? <p style={S.note}>{props.saveDisabled}</p> : null}
			{props.views.length === 0 ? (
				<p style={S.note}>No saved views yet.</p>
			) : (
				<ul style={MAP_STYLES.list} aria-label="Views of this connection">
					{props.views.map((view) => (
						<li key={view.id} style={S.entry} data-view-id={view.id}>
							<span style={S.words}>
								<span style={S.name} title={view.name}>
									{view.name}
								</span>
								<span style={S.summary}>
									{viewSummary(view)} · {savedAt(view.savedAt)}
								</span>
							</span>
							<button type="button" style={{ ...S.small, ...(busy ? MAP_STYLES.buttonDisabled : null) }} disabled={busy} aria-label={`Apply view ${view.name}`} onClick={() => props.onApply(view)}>
								Apply
							</button>
							<button type="button" style={{ ...S.small, ...(busy ? MAP_STYLES.buttonDisabled : null) }} disabled={busy} aria-label={`Delete view ${view.name}`} onClick={() => props.onDelete(view)}>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}
			<p style={S.note}>{keepSentence(props.limits)} Views are kept for this connection until you sign out.</p>
			<p role="status" style={S.note} data-views-status="">
				{props.status ?? ''}
			</p>
		</div>
	);
}

/**
 * The Views menu.
 *
 * @param props - Connection, limits, the map's current view and its apply (frozen props).
 * @returns The button and, when open, its panel.
 */
export function SavedViewsMenu(props: SavedViewsMenuProps): React.ReactElement {
	const { connectionKey, limits } = props;
	const panelId = `views-${useId().replace(/:/g, '')}`;
	const [open, setOpen] = useState(false);
	const [side, setSide] = useState<'left' | 'right'>('right');
	const [name, setName] = useState('');
	const [status, setStatus] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [, setVersion] = useState(0);
	const root = useRef<HTMLSpanElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const nameField = useRef<HTMLInputElement>(null);
	const live = useRef(true);
	const views = listViews(savedViews, connectionKey);
	const refresh = (): void => setVersion((v) => v + 1);

	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);

	// Another connection: its own views, no stale status.
	useEffect(() => {
		setStatus(null);
		setName('');
	}, [connectionKey]);

	// Close on a click outside while open.
	useEffect(() => {
		if (!open) return undefined;
		const onDown = (event: MouseEvent): void => {
			if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
		};
		document.addEventListener('mousedown', onDown);
		return () => document.removeEventListener('mousedown', onDown);
	}, [open]);

	// Opening puts the cursor in the name field.
	useEffect(() => {
		if (open) nameField.current?.focus();
	}, [open]);

	const save = useCallback((): void => {
		let state: ReturnType<typeof props.current>;
		try {
			state = props.current();
		} catch {
			setStatus('The current view could not be read.');
			return;
		}
		const now = Date.now();
		const chosen = name.trim() === '' ? defaultViewName(listViews(savedViews, connectionKey)) : name;
		const result = saveView(savedViews, connectionKey, chosen, state, limits, { now, id: newViewId(now) });
		if (!result.ok) {
			setStatus(result.reason);
			return;
		}
		const kept = result.dropped > 0 ? ` (${result.kept.toLocaleString('en-US')} of ${(result.kept + result.dropped).toLocaleString('en-US')} selected points kept)` : '';
		setStatus(`${result.replaced ? 'Replaced' : 'Saved'} “${result.view.name}”${kept}.`);
		setName('');
		refresh();
	}, [props, name, connectionKey, limits]);

	const apply = useCallback(
		(view: ISavedView): void => {
			setBusyId(view.id);
			setStatus(`Applying ${view.name}…`);
			Promise.resolve()
				.then(() => props.onApply(view))
				.then(
					(restored) => (restored ? `${restoreSentence(restored)}.${view.query ? ` ${QUERY_NOT_RUN}` : ''}` : APPLY_FAILED),
					() => APPLY_FAILED
				)
				.then((line) => {
					if (!live.current) return;
					setBusyId(null);
					setStatus(line);
				});
		},
		[props]
	);

	const remove = useCallback(
		(view: ISavedView): void => {
			if (deleteView(savedViews, connectionKey, view.id)) setStatus(`Deleted “${view.name}”.`);
			refresh();
		},
		[connectionKey]
	);

	return (
		<span
			ref={root}
			role="group"
			aria-label="Views"
			data-component="SavedViewsMenu"
			data-views={views.length}
			style={S.root}
			onKeyDown={(event) => {
				if (event.key === 'Escape' && open) {
					event.stopPropagation();
					setOpen(false);
					button.current?.focus();
				}
			}}
		>
			<button
				ref={button}
				type="button"
				style={MAP_STYLES.button}
				aria-expanded={open}
				aria-controls={open ? panelId : undefined}
				onClick={() => {
					if (!open) setSide(sideFor(root.current, VIEWS_PANEL_WIDTH));
					setOpen((v) => !v);
				}}
			>
				Views{views.length > 0 ? ` (${views.length})` : ''} ▾
			</button>
			{open ? <SavedViewsPanel id={panelId} side={side} limits={limits} views={views} name={name} busyId={busyId} status={status} saveDisabled={saveBlocker(savedViews, connectionKey)} nameRef={nameField} onName={setName} onSave={save} onApply={apply} onDelete={remove} /> : null}
			{!open && status ? (
				<span role="status" style={S.hidden}>
					{status}
				</span>
			) : null}
		</span>
	);
}

export default SavedViewsMenu;
