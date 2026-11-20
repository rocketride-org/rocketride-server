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
// VECTOR-UI - THE QUERY TAB'S HISTORY (an aside docked beside the modes)
// =============================================================================
//
// The runs, newest first and pinned ones on top: the question (a Compare's A
// and B), then its kind, k, what it came to, when and how long. A run that
// repeats the newest entry's whole question updates that entry instead of
// adding one, and the entry says "Ran again". Each entry
// has Load (fills the form, runs nothing), Rerun (its mode and k with the
// threshold, scope and table filter chosen now; off, with the reason, when
// it cannot run), Pin, a one-line Note and Remove. "Record runs" turns
// recording off and on (entries already kept stay). "Clear…" asks inline,
// never in a dialog: rocket-ui keeps hidden documents mounted. The footer is
// the mount's own sentence about where the history is kept.
//
// The focus never falls to <body> (vector/queryFocus.ts): a removed entry
// hands it to the next one, else the previous, else the heading; "Clear…"
// confirmed goes to the heading, cancelled back to "Clear…"; a note saved or
// cancelled goes back to its Note button. Escape: the note box and the
// confirmation each handle their own, and the aside closes on one nothing
// inside it handled. The model is vector/queryHistory.ts.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { firstFocusable } from '../vector/focus';
import { escapeLayer, focusAfterClear, focusAfterPin, focusAfterRemove } from '../vector/queryFocus';
import type { QueryFocusTarget } from '../vector/queryFocus';
import { HISTORY_FILTERS, RAN_AGAIN, entryMeta, shownEntries, shownQuestion } from '../vector/queryHistory';
import type { HistoryFilter, QueryHistoryItem, RerunPlan } from '../vector/queryHistory';

/** Props for the {@link HistoryAside} component. */
export interface IHistoryAsideProps {
	/** The aside's id (the History button's aria-controls). */
	id: string;
	/** The connection's entries, newest first. */
	entries: readonly QueryHistoryItem[];
	/** Whether runs are recorded now. */
	recording: boolean;
	onRecording(on: boolean): void;
	/** Where the history is kept (the mount's own sentence). */
	note: string;
	/** Now, for the entries' times. */
	now: number;
	/** The entry the last run landed on when it repeated the newest question (no entry added), or null. */
	ranAgain?: string | null;
	/** What Rerun would do with an entry, or why it cannot. */
	rerunOf(entry: QueryHistoryItem): RerunPlan;
	onLoad(entry: QueryHistoryItem): void;
	onRerun(entry: QueryHistoryItem): void;
	onPin(id: string): void;
	onNote(id: string, note: string): void;
	onRemove(id: string): void;
	onClear(): void;
	/** Close the aside (Escape that nothing inside handled). */
	onClose(): void;
}

const S = {
	root: { flex: '1 1 300px', minWidth: 0, minHeight: 0, maxHeight: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '0 0 0 12px', borderLeft: '1px solid var(--rr-border)', fontSize: 12, color: 'var(--rr-text-primary)' } as CSSProperties,
	head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' } as CSSProperties,
	heading: { margin: 0, fontSize: 13, fontWeight: 600 } as CSSProperties,
	row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } as CSSProperties,
	select: { fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)' } as CSSProperties,
	button: { ...commonStyles.buttonSecondary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	danger: { ...commonStyles.buttonPrimary, padding: '1px 8px', fontSize: 11 } as CSSProperties,
	off: { opacity: 0.55, cursor: 'not-allowed' } as CSSProperties,
	line: { margin: 0, fontSize: 12 } as CSSProperties,
	list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	entry: { borderTop: '1px solid var(--rr-border)', paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 3 } as CSSProperties,
	question: { margin: 0, fontSize: 12, fontWeight: 600, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } as CSSProperties,
	meta: { margin: 0, fontSize: 11 } as CSSProperties,
	input: { flex: '1 1 140px', minWidth: 0, fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--rr-border-input)', background: 'var(--rr-bg-input)', color: 'var(--rr-text-primary)', fontFamily: 'inherit' } as CSSProperties,
	confirm: { border: '1px solid var(--rr-border)', borderRadius: 6, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	footer: { margin: '6px 0 0', fontSize: 11 } as CSSProperties,
};

/** The longest note kept on an entry. */
const NOTE_MAX_CHARS = 200;

/** Where the focus goes after an action: a control of the aside, or a control of one entry. */
type AsideFocus = QueryFocusTarget | { entry: string; control: 'load' | 'note' | 'pin' | 'note-input' };

/**
 * The Query tab's History.
 *
 * @param props - {@link IHistoryAsideProps}.
 * @returns The aside.
 */
export function HistoryAside({ id, entries, recording, onRecording, note, now, ranAgain = null, rerunOf, onLoad, onRerun, onPin, onNote, onRemove, onClear, onClose }: IHistoryAsideProps): React.ReactElement {
	const root = useRef<HTMLElement>(null);
	const [filter, setFilter] = useState<HistoryFilter>('all');
	const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [focusNext, setFocusNext] = useState<AsideFocus | null>(null);
	const shown = shownEntries(entries, filter);

	// The focus an action asked for, once the entries it changed are drawn: that control, else the Show filter, else the
	// heading (vector/focus.ts firstFocusable: never <body>, never a control that is gone or hidden).
	useEffect(() => {
		if (focusNext === null) return;
		const element = root.current;
		const selector = typeof focusNext === 'string' ? `[data-query-focus="${focusNext}"]` : `[data-history-entry="${focusNext.entry}"] [data-history-control="${focusNext.control}"]`;
		const find = (query: string): HTMLElement | null => element?.querySelector<HTMLElement>(query) ?? null;
		firstFocusable([find(selector), find('[data-history-control="filter"]'), find('[data-query-focus="history-heading"]')])?.focus();
		setFocusNext(null);
	}, [focusNext, entries]);

	// A note box opens with the focus in it.
	const editingId = editing?.id ?? null;
	useEffect(() => {
		if (editingId !== null) setFocusNext({ entry: editingId, control: 'note-input' });
	}, [editingId]);

	// "Clear…" opens with Cancel focused: clearing cannot be undone.
	useEffect(() => {
		if (confirming) root.current?.querySelector<HTMLElement>('[data-history-confirm] [data-history-control="cancel"]')?.focus();
	}, [confirming]);

	/**
	 * Close the "Clear…" confirmation.
	 *
	 * @param confirmed - Clear the history.
	 */
	const closeConfirm = (confirmed: boolean): void => {
		if (confirmed) {
			const n = entries.length;
			onClear();
			setResult(n === 1 ? 'Removed 1 entry.' : `Removed ${n} entries.`);
		}
		setConfirming(false);
		setFocusNext(focusAfterClear(confirmed));
	};

	/**
	 * Close the note box of an entry.
	 *
	 * @param entryId - The entry.
	 * @param save - Keep the draft.
	 */
	const closeNote = (entryId: string, save: boolean): void => {
		if (save && editing !== null) onNote(entryId, editing.draft.trim());
		setEditing(null);
		setFocusNext({ entry: entryId, control: 'note' });
	};

	return (
		<aside
			ref={root}
			id={id}
			aria-label="History"
			data-component="HistoryAside"
			style={S.root}
			onKeyDown={(event) => {
				if (event.key !== 'Escape' || escapeLayer(event.defaultPrevented) !== 'act') return;
				event.preventDefault();
				onClose();
			}}
		>
			<div style={S.head}>
				<h3 style={S.heading} tabIndex={-1} data-query-focus="history-heading">
					History
				</h3>
				<button type="button" style={S.button} disabled={entries.length === 0 && !confirming} data-query-focus="history-clear" onClick={() => setConfirming(true)}>
					Clear…
				</button>
			</div>
			<div style={S.row}>
				<label style={S.row}>
					<input type="checkbox" role="switch" checked={recording} aria-checked={recording} onChange={(event) => onRecording(event.currentTarget.checked)} />
					Record runs
				</label>
				<label style={S.row}>
					Show
					<select style={S.select} value={filter} data-history-control="filter" onChange={(event) => setFilter(event.currentTarget.value as HistoryFilter)}>
						{HISTORY_FILTERS.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
				</label>
			</div>
			{!recording && <p style={S.line}>Recording is off: new runs are not added. The entries below stay.</p>}
			{confirming && (
				<div
					style={S.confirm}
					data-history-confirm=""
					onKeyDown={(event) => {
						if (event.key !== 'Escape' || escapeLayer(event.defaultPrevented) !== 'act') return;
						event.preventDefault();
						closeConfirm(false);
					}}
				>
					<p style={S.line}>{entries.length === 1 ? 'Remove the one entry, pinned or not?' : `Remove all ${entries.length} entries, pinned ones too?`} This cannot be undone.</p>
					<div style={S.row}>
						<button type="button" style={S.button} data-history-control="cancel" onClick={() => closeConfirm(false)}>
							Cancel
						</button>
						<button type="button" style={S.danger} onClick={() => closeConfirm(true)}>
							Remove all
						</button>
					</div>
				</div>
			)}
			{result !== null && (
				<p style={S.line} role="status">
					{result}
				</p>
			)}
			{shown.length === 0 ? (
				<p style={S.line}>{entries.length === 0 ? 'No runs yet. Search, Compare and Ask runs are listed here.' : 'No runs match this filter.'}</p>
			) : (
				<ul style={S.list} aria-label="Runs">
					{shown.map((entry) => {
						const plan = rerunOf(entry);
						const short = entry.question.length > 40 ? `${entry.question.slice(0, 39)}…` : entry.question;
						return (
							<li key={entry.id} style={S.entry} data-history-entry={entry.id} data-kind={entry.kind}>
								<p style={S.question}>{shownQuestion(entry)}</p>
								<p style={S.meta}>{entryMeta(entry, now)}</p>
								{ranAgain === entry.id && (
									<p style={S.meta} data-ran-again="">
										{RAN_AGAIN}
									</p>
								)}
								{!plan.ok && <p style={S.meta}>{`Rerun is off: ${plan.reason}`}</p>}
								{entry.note !== undefined && entry.note !== '' && editing?.id !== entry.id && <p style={S.meta}>{`Note: ${entry.note}`}</p>}
								{editing?.id === entry.id && (
									<div style={S.row}>
										<input
											style={S.input}
											aria-label={`Note on "${short}"`}
											value={editing.draft}
											maxLength={NOTE_MAX_CHARS}
											data-history-control="note-input"
											onChange={(event) => setEditing({ id: entry.id, draft: event.currentTarget.value })}
											onKeyDown={(event) => {
												if (event.key === 'Enter') {
													event.preventDefault();
													closeNote(entry.id, true);
												} else if (event.key === 'Escape' && escapeLayer(event.defaultPrevented) === 'act') {
													event.preventDefault();
													closeNote(entry.id, false);
												}
											}}
										/>
										<button type="button" style={S.button} onClick={() => closeNote(entry.id, true)}>
											Save
										</button>
										<button type="button" style={S.button} onClick={() => closeNote(entry.id, false)}>
											Cancel
										</button>
									</div>
								)}
								<div style={S.row}>
									<button type="button" style={S.button} data-history-control="load" title="Put it back in the form; nothing runs" onClick={() => onLoad(entry)}>
										Load
									</button>
									<button
										type="button"
										style={plan.ok ? S.button : { ...S.button, ...S.off }}
										data-history-control="rerun"
										aria-disabled={!plan.ok}
										title={plan.ok ? plan.title : plan.reason}
										onClick={() => {
											if (plan.ok) onRerun(entry);
										}}
									>
										Rerun
									</button>
									<button
										type="button"
										style={S.button}
										data-history-control="pin"
										aria-pressed={entry.pinned === true}
										onClick={() => {
											// A pinned entry moves to the top (and back), and the focus goes with it; unpinned under "Pinned" it
											// leaves the list, and the focus goes where a removed entry's would.
											const next = focusAfterPin(
												filter === 'pinned',
												shown.map((e) => e.id),
												entry.id,
												entry.pinned === true
											);
											onPin(entry.id);
											setFocusNext(next);
										}}
									>
										Pin
									</button>
									<button type="button" style={S.button} data-history-control="note" onClick={() => setEditing({ id: entry.id, draft: entry.note ?? '' })}>
										Note
									</button>
									<button
										type="button"
										style={S.button}
										data-history-control="remove"
										aria-label={`Remove "${short}" from History`}
										onClick={() => {
											const next = focusAfterRemove(
												shown.map((e) => e.id),
												entry.id
											);
											onRemove(entry.id);
											setFocusNext(typeof next === 'string' ? next : { entry: next.entry, control: 'load' });
										}}
									>
										Remove
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<p style={S.footer} data-history-note="">
				{note}
			</p>
		</aside>
	);
}

export default HistoryAside;
