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
// SQL-UI — HISTORY PANEL (what you ran on this connection, and when)
// =============================================================================
//
// A MODELESS right drawer: the editor behind it stays usable, because the
// point of history is to work alongside the statement being written, not
// instead of it.
//
// The privacy notice is not decoration. These statements are written to the
// user's workspace file on the RocketRide server, verbatim, including any
// literal values typed into a WHERE clause. Someone who assumes browser-local
// storage would be wrong in a way that matters, so the drawer says where the
// text goes, in the drawer, every time it is open.
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
	Button,
	ConfirmDialog,
	DetailPanel,
	EmptyState,
	InputField,
	Section,
	StatusBadge,
	ToggleGroup,
	useDebouncedValue,
} from 'shell';
import type { ISqlEndpoint } from '../connect';
import type { IHistoryEntry } from '../history/types';
import {
	HistoryPrefsBridge,
	clearForKey,
	removeEntry,
	setNote,
	setRecording,
	togglePin,
	useHistory,
	useRecording,
} from '../history/historyStore';
import { DEFAULT_HISTORY_LIMITS } from '../history/trim';
import { getDocs, nextQueryDoc } from '../docs';
import type { IQueryDocPayload } from '../docs';
import { announce } from '../a11y/announce';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link HistoryPanel} component. */
export interface IHistoryPanelProps {
	/** The connection whose history is shown. */
	endpoint: ISqlEndpoint;
	/** Whether the drawer is open. */
	open: boolean;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
	/**
	 * Put one statement into the query editor.
	 *
	 * The drawer does not know the editor's current text, so it never asks
	 * before replacing it — the query view owns that confirmation, because it
	 * is the only side that can tell an untouched editor from an edited one.
	 */
	onLoadIntoEditor: (sql: string) => void;
	/**
	 * Run one statement again. The drawer has already confirmed anything that
	 * changed data when it last ran, so this fires with the user's consent.
	 */
	onRerun: (entry: IHistoryEntry) => void;
}

/** The list filters across the top of the drawer. */
type HistoryFilter = 'all' | 'reads' | 'writes' | 'errors' | 'pinned';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Where history is stored, said plainly. Approved wording — the statement
 * text leaves the browser, and a person deserves to know that before they
 * type a password into a WHERE clause.
 */
const PRIVACY_NOTICE = 'Saved in your RocketRide workspace file on the server, not in this browser. Statements are stored as typed, including literal values.';

/** The filter strip's options. */
const FILTERS: { id: HistoryFilter; label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'reads', label: 'Reads' },
	{ id: 'writes', label: 'Writes' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'pinned', label: 'Pinned' },
];

/** Badge text per statement kind. */
const KIND_LABEL: Record<IHistoryEntry['kind'], string> = {
	read: 'READ',
	write: 'WRITE',
	ddl: 'DDL',
	tx: 'TX',
	other: 'OTHER',
};

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	avatar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 42,
		height: 42,
		borderRadius: '50%',
		background: 'var(--rr-bg-widget)',
		color: 'var(--rr-brand)',
		padding: 10,
	} as CSSProperties,

	controls: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		paddingBottom: 12,
	} as CSSProperties,

	search: {
		width: '100%',
	} as CSSProperties,

	// One history row: a full-width button so the whole line is the target.
	row: {
		display: 'block',
		width: '100%',
		textAlign: 'left',
		background: 'transparent',
		border: 'none',
		borderBottom: '1px solid var(--rr-bg-widget)',
		padding: '8px 0',
		cursor: 'pointer',
		font: 'inherit',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	rowTop: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	rowTime: {
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	rowSql: {
		// Block, because `overflow`, `textOverflow` and vertical margins do
		// nothing on an inline box: as a span the statement overflowed the
		// drawer instead of ending in an ellipsis.
		display: 'block',
		marginTop: 4,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12.5,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	rowNote: {
		// Block for the same reason, and so the note sits UNDER the statement
		// rather than running on beside it.
		display: 'block',
		marginTop: 2,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	detail: {
		padding: '10px 0 14px',
		borderBottom: '1px solid var(--rr-bg-widget)',
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
	} as CSSProperties,

	sql: {
		margin: 0,
		maxHeight: 220,
		overflow: 'auto',
		background: 'var(--rr-bg-widget)',
		borderRadius: 6,
		padding: 10,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	meta: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	error: {
		margin: 0,
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12,
		color: 'var(--rr-color-error)',
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,

	actions: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: 6,
	} as CSSProperties,

	notice: {
		marginTop: 16,
		fontSize: 11.5,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	capLine: {
		marginTop: 8,
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Clock time of one entry, e.g. `14:02`.
 *
 * @param at - Unix ms.
 * @returns The local time of day.
 */
function clock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The outcome badge's text and severity.
 *
 * @param entry - The entry to describe.
 * @returns The badge variant and its label.
 */
function outcomeBadge(entry: IHistoryEntry): { variant: 'success' | 'info' | 'error' | 'muted'; label: string } {
	switch (entry.outcome) {
		case 'rows': return {
			variant: 'success',
			// A bare row count cannot say whether it is the whole answer or
			// the ceiling cutting it off, so it never appears without one.
			label: entry.limit !== undefined
				? `${entry.rows ?? 0} rows (limit ${entry.limit})`
				: `${entry.rows ?? 0} rows returned`,
		};
		case 'affected': return { variant: 'info', label: `${entry.affected ?? 0} affected` };
		case 'error': return { variant: 'error', label: 'error' };
		default: return { variant: 'muted', label: 'abandoned' };
	}
}

/**
 * The first non-empty line of a statement, for the collapsed row.
 *
 * @param sql - The statement text.
 * @returns The first line with meaning, or the whole text when there is none.
 */
function firstLine(sql: string): string {
	const line = sql.split('\n').map((part) => part.trim()).find(Boolean);
	return line ?? sql.trim();
}

/**
 * Whether a statement changed data when it last ran, so a rerun needs
 * confirming. Judged from the entry's KIND, which came from a text pattern —
 * a lexical reading of the statement, not a promise from the database.
 *
 * @param entry - The entry.
 * @returns True for writes and schema changes.
 */
function changesData(entry: IHistoryEntry): boolean {
	return entry.kind === 'write' || entry.kind === 'ddl';
}

/**
 * The full accessible name of a row, so a screen reader gets the same facts
 * the eye does: when, what kind, how it ended, and the statement itself.
 *
 * @param entry - The entry.
 * @returns The row's accessible label.
 */
function rowLabel(entry: IHistoryEntry): string {
	const badge = outcomeBadge(entry);
	const parts = [clock(entry.at), KIND_LABEL[entry.kind].toLowerCase(), badge.label];
	if (entry.pinned) parts.push('pinned');
	if (entry.note) parts.push(`note: ${entry.note}`);
	parts.push(firstLine(entry.sql));
	return parts.join(', ');
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The per-connection history drawer: search, filter, inspect, reload, rerun,
 * pin, annotate and delete the statements run on one connection.
 *
 * @param props - {@link IHistoryPanelProps}.
 * @returns The drawer element.
 */
export const HistoryPanel: React.FC<IHistoryPanelProps> = (props) => {
	const { endpoint, open, onClose, onLoadIntoEditor, onRerun } = props;

	const entries = useHistory(endpoint.key);
	const isRecording = useRecording(endpoint.key);

	const [search, setSearch] = useState('');
	const debouncedSearch = useDebouncedValue(search, 200);
	const [filter, setFilter] = useState<HistoryFilter>('all');
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [noteDraft, setNoteDraft] = useState('');
	const [confirmRerun, setConfirmRerun] = useState<IHistoryEntry | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);

	// ── Visible rows ─────────────────────────────────────────────────────────

	const visible = useMemo(() => {
		const term = debouncedSearch.trim().toLowerCase();
		return entries.filter((entry) => {
			if (filter === 'reads' && entry.kind !== 'read') return false;
			if (filter === 'writes' && !changesData(entry)) return false;
			if (filter === 'errors' && entry.outcome !== 'error') return false;
			if (filter === 'pinned' && !entry.pinned) return false;
			if (!term) return true;
			return entry.sql.toLowerCase().includes(term)
				|| (entry.note ?? '').toLowerCase().includes(term);
		});
	}, [entries, filter, debouncedSearch]);

	// ── Row actions ──────────────────────────────────────────────────────────

	/**
	 * Expand or collapse one row, seeding the note editor from the entry.
	 *
	 * @param entry - The row's entry.
	 */
	const toggleExpanded = (entry: IHistoryEntry): void => {
		if (expandedId === entry.id) {
			setExpandedId(null);
			return;
		}
		setExpandedId(entry.id);
		setNoteDraft(entry.note ?? '');
	};

	/**
	 * Open one statement in a NEW query document, leaving the current editor
	 * alone. Nothing runs: the document opens with the text and waits.
	 *
	 * @param entry - The entry to open.
	 */
	const openInNewQuery = (entry: IHistoryEntry): void => {
		const { uri, label } = nextQueryDoc(endpoint.key);
		// No `origin: 'generated'` — this statement is the user's own text,
		// not something this app wrote, and must not claim otherwise.
		const payload: IQueryDocPayload = { endpoint, label, initialSql: entry.sql };
		getDocs()?.openStaticDocument(uri, label, payload);
		announce(`Opened ${label}`);
	};

	/**
	 * Run one entry again, confirming first when it changed data last time.
	 *
	 * @param entry - The entry to rerun.
	 */
	const requestRerun = (entry: IHistoryEntry): void => {
		if (changesData(entry)) {
			setConfirmRerun(entry);
			return;
		}
		onRerun(entry);
	};

	// ── Body ─────────────────────────────────────────────────────────────────

	/**
	 * The list region: rows, or the empty state that explains the silence.
	 *
	 * @returns The list content.
	 */
	const renderList = (): React.ReactNode => {
		if (entries.length === 0) {
			return (
				<EmptyState
					icon={<DatabaseIcon />}
					title={isRecording ? 'No history yet' : 'Recording is off for this connection'}
					description={isRecording
						? 'Statements you run on this connection appear here.'
						: 'Statements you run are not being recorded. Existing entries are kept.'}
				/>
			);
		}
		if (visible.length === 0) {
			return <EmptyState title="Nothing matches" description="No entry matches this search and filter." />;
		}

		return visible.map((entry) => {
			const badge = outcomeBadge(entry);
			const expanded = expandedId === entry.id;

			return (
				<div key={entry.id}>
					<button
						type="button"
						style={styles.row}
						aria-expanded={expanded}
						aria-label={rowLabel(entry)}
						onClick={() => toggleExpanded(entry)}
					>
						<span style={styles.rowTop}>
							<span style={styles.rowTime}>{clock(entry.at)}</span>
							<StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
							<StatusBadge variant="muted">{KIND_LABEL[entry.kind]}</StatusBadge>
							{entry.pinned && <StatusBadge variant="info">Pinned</StatusBadge>}
							{entry.truncated && <StatusBadge variant="muted">truncated</StatusBadge>}
						</span>
						<span style={styles.rowSql}>{firstLine(entry.sql)}</span>
						{entry.note && <span style={styles.rowNote}>{entry.note}</span>}
					</button>

					{expanded && (
						<div style={styles.detail}>
							<pre style={styles.sql}>{entry.sql}</pre>
							{entry.truncated && (
								<div style={styles.meta}>
									{`Stored text was cut at ${DEFAULT_HISTORY_LIMITS.maxSqlChars} characters; the rest was not kept.`}
								</div>
							)}
							<div style={styles.meta}>
								{`executed ${clock(entry.at)} · round trip ${(entry.ms / 1000).toFixed(3)} s`}
								{changesData(entry) ? ' · autocommit' : ''}
							</div>
							{entry.error && <pre style={styles.error}>{entry.error}</pre>}

							<label>
								<span style={styles.meta}>Note</span>
								<InputField
									style={styles.search}
									value={noteDraft}
									placeholder="Why this statement matters"
									onChange={(event) => setNoteDraft(event.target.value)}
									onBlur={() => setNote(endpoint.key, entry.id, noteDraft.trim())}
									onKeyDown={(event) => {
										if (event.key === 'Enter') setNote(endpoint.key, entry.id, noteDraft.trim());
									}}
								/>
							</label>

							<div style={styles.actions}>
								{/* No announcement here: the query view may raise a
								    "Replace editor text?" confirm that the user
								    cancels, and it announces the load that does
								    happen. Announcing both would be wrong once
								    and duplicated the rest of the time. */}
								<Button variant="secondary" small onClick={() => onLoadIntoEditor(entry.sql)}>
									Load into editor
								</Button>
								<Button variant="primary" small onClick={() => requestRerun(entry)}>Rerun</Button>
								<Button
									variant="ghost"
									small
									pressed={!!entry.pinned}
									onClick={() => {
										togglePin(endpoint.key, entry.id);
										announce(entry.pinned ? 'Entry unpinned' : 'Entry pinned');
									}}
								>
									{entry.pinned ? 'Unpin' : 'Pin'}
								</Button>
								<Button
									variant="ghost"
									small
									onClick={() => {
										removeEntry(endpoint.key, entry.id);
										setExpandedId(null);
										announce('Entry deleted');
									}}
								>
									Delete
								</Button>
								<Button variant="ghost" small onClick={() => openInNewQuery(entry)}>Open in new query</Button>
							</div>
						</div>
					)}
				</div>
			);
		});
	};

	// ── Rerun confirmation ───────────────────────────────────────────────────

	/**
	 * The rerun warning's body. It quotes what the statement did LAST time,
	 * because that is the only evidence available — nothing is counted or
	 * checked against the database before running it again.
	 *
	 * @param entry - The entry being rerun.
	 * @returns The dialog message.
	 */
	const rerunMessage = (entry: IHistoryEntry): string => {
		if (entry.outcome === 'affected' && entry.affected !== undefined) {
			return `This statement changed data when last run (${entry.affected} rows affected at ${clock(entry.at)}). It runs immediately and autocommits.`;
		}
		return `This statement changes data. It runs immediately and autocommits.`;
	};

	return (
		<>
			{/* Keeps the store's access to workspace preferences alive while the
			    drawer is open, so a run recorded now is actually written. */}
			<HistoryPrefsBridge />

			<DetailPanel
				open={open}
				onClose={onClose}
				modeless
				width={440}
				persistKey="sqlHistoryWidth"
				avatar={<span style={styles.avatar}><DatabaseIcon /></span>}
				title="History"
				subtitle={`${endpoint.nodeName} · this connection`}
				footer={
					<>
						{/* The label carries the state in TEXT. `pressed` alone
						    left on and off separated by colour, which is no
						    difference at all to a reader who cannot see it. */}
						<Button
							variant="ghost"
							small
							pressed={isRecording}
							title="Record the statements you run on this connection"
							onClick={() => {
								setRecording(endpoint.key, !isRecording);
								announce(isRecording ? 'Recording off for this connection' : 'Recording on for this connection');
							}}
						>
							{isRecording ? 'Recording: on' : 'Recording: off'}
						</Button>
						<Button variant="ghost" small disabled={entries.length === 0} onClick={() => setConfirmClear(true)}>
							Clear...
						</Button>
					</>
				}
			>
				<div style={styles.controls}>
					<InputField
						type="search"
						style={styles.search}
						aria-label="Search statements and notes"
						placeholder="Search statements and notes"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<ToggleGroup options={FILTERS} value={filter} onChange={setFilter} wrap />
				</div>

				<Section label={`Statements (${visible.length})`}>
					{renderList()}
				</Section>

				{entries.length >= DEFAULT_HISTORY_LIMITS.maxEntries && (
					<div style={styles.capLine}>
						{`${entries.length} of ${DEFAULT_HISTORY_LIMITS.maxEntries} kept — the oldest unpinned entry drops as new ones arrive.`}
					</div>
				)}

				<div style={styles.notice}>{PRIVACY_NOTICE}</div>
			</DetailPanel>

			{confirmRerun && (
				<ConfirmDialog
					title="Run this again?"
					message={rerunMessage(confirmRerun)}
					confirmLabel="Run again"
					destructive
					onCancel={() => setConfirmRerun(null)}
					onConfirm={() => {
						const entry = confirmRerun;
						setConfirmRerun(null);
						onRerun(entry);
					}}
				/>
			)}

			{confirmClear && (
				<ConfirmDialog
					title="Clear history?"
					message={`Clear ${entries.length} entries for ${endpoint.nodeName}? Pinned entries are removed too.`}
					confirmLabel="Clear"
					destructive
					onCancel={() => setConfirmClear(false)}
					onConfirm={() => {
						clearForKey(endpoint.key);
						setConfirmClear(false);
						setExpandedId(null);
						announce('History cleared for this connection');
					}}
				/>
			)}
		</>
	);
};

export default HistoryPanel;
