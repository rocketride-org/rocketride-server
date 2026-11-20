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
// GRAPH-UI - HISTORY PANEL (statements run on one connection)
// =============================================================================
//
// Reads the shared history store under the graph.* keys. Each entry holds only the
// statement text, its timing, count and outcome, and the user's pin and note: never
// a token, a connection string or a result. The entries are written ON THE SERVER,
// verbatim, including any literal values typed into a statement, and the panel says
// so in the words of its mount: the full app keeps them in the workspace file, a dev
// tool in a file in the user's folder (env.historyPrivacyNote).
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, ConfirmDialog, DetailPanel, EmptyState, InputField, StatusBadge } from 'shell';
import { clock, readErrorMessage } from 'shared/explorer';
import type { IHistoryEntry } from 'shared/explorer';
import { APP_HISTORY_PRIVACY_NOTE, useGraphEnv, useHistoryView } from '../env';
import { GraphIcon } from '../icons';

/** The full app's privacy note, word for word the same as SQL Explorer's (each mount says its own: env.historyPrivacyNote). */
export const HISTORY_PRIVACY_NOTE = APP_HISTORY_PRIVACY_NOTE;

/** Props. */
export interface IHistoryPanelProps {
	endpointKey: string;
	nodeName: string;
	open: boolean;
	onClose(): void;
	/** Put the statement in the editor. */
	onLoad(cypher: string): void;
	/** Run the statement again (an explicit gesture; nothing reruns by itself). */
	onRerun(cypher: string): void;
	announce(text: string): void;
}

/**
 * One line summarising how an entry ended.
 *
 * @param entry - A history entry.
 * @returns Text such as `3 rows (limit 1,000)` or `stopped waiting`.
 */
export function entrySummary(entry: IHistoryEntry<'cypher'>): string {
	switch (entry.outcome) {
		case 'rows':
			return `${(entry.rows ?? 0).toLocaleString('en-US')} ${entry.rows === 1 ? 'row' : 'rows'}${entry.limit !== undefined ? ` (limit ${entry.limit.toLocaleString('en-US')})` : ''}`;
		case 'affected':
			return `${(entry.affected ?? 0).toLocaleString('en-US')} affected`;
		case 'abandoned':
			return 'stopped waiting; the database may have finished it';
		default:
			return entry.error ? `failed: ${entry.error.split('\n')[0]}` : 'failed';
	}
}

/**
 * What an empty History list says.
 *
 * @param entries - How many entries the connection has before the search and Pinned only are applied.
 * @param recording - Whether recording is on for the connection.
 * @returns The title and description.
 */
export function historyEmptyText(entries: number, recording: boolean): { title: string; description: string } {
	if (entries > 0) return { title: 'No entries match', description: 'No statement or note matches the search, or none of them is pinned. Clear the search or turn off Pinned only.' };
	return recording ? { title: 'No history yet', description: 'Statements you run on this connection appear here.' } : { title: 'Recording is off for this connection', description: 'Turn recording on to keep the statements you run.' };
}

const styles = {
	row: { borderBottom: '1px solid var(--rr-border)', padding: '8px 0' } as CSSProperties,
	text: { fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0' } as CSSProperties,
	meta: { fontSize: 11.5, color: 'var(--rr-text-secondary)' } as CSSProperties,
	actions: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } as CSSProperties,
};

/**
 * The history drawer.
 *
 * @param props - See {@link IHistoryPanelProps}.
 * @returns The drawer.
 */
export const HistoryPanel: React.FC<IHistoryPanelProps> = ({ endpointKey, nodeName, open, onClose, onLoad, onRerun, announce }) => {
	const env = useGraphEnv();
	const history = env.history;
	const { entries, recording } = useHistoryView(endpointKey);
	// A change is announced once it is APPLIED (a dev-tool frame waits for the controller's Reply), and a refused or
	// lost one says so instead.
	const failed = (what: string) => (error: unknown): void => announce(`${what} ${readErrorMessage(error)}`);
	const [search, setSearch] = useState('');
	const [pinnedOnly, setPinnedOnly] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [open1, setOpen1] = useState<string | null>(null);
	const [note, setNote] = useState('');

	const shown = useMemo(() => {
		const term = search.trim().toLowerCase();
		return entries.filter((e) => (!pinnedOnly || e.pinned) && (term === '' || e.cypher.toLowerCase().includes(term) || (e.note ?? '').toLowerCase().includes(term)));
	}, [entries, search, pinnedOnly]);

	return (
		<>
			<DetailPanel open={open} onClose={onClose} avatar={<GraphIcon />} title="History" subtitle={nodeName}>
				<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', marginBottom: 10 }}>{env.historyPrivacyNote}</div>
				<div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
					<Button variant="ghost" small pressed={recording} onClick={() => { void history.setRecording(endpointKey, !recording).then(() => announce(recording ? 'Recording off for this connection.' : 'Recording on for this connection.'), failed('Recording was not changed.')); }}>
						{recording ? 'Recording: on' : 'Recording: off'}
					</Button>
					<Button variant="ghost" small pressed={pinnedOnly} onClick={() => setPinnedOnly((v) => !v)}>Pinned only</Button>
					<Button variant="ghost" small disabled={entries.length === 0} onClick={() => setConfirmClear(true)}>Clear...</Button>
				</div>
				<InputField value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search statements and notes" aria-label="Search statements and notes" />
				{shown.length === 0 ? (
					<div style={{ marginTop: 16 }}>
						<EmptyState icon={<GraphIcon />} {...historyEmptyText(entries.length, recording)} />
					</div>
				) : (
					<ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
						{shown.map((entry) => {
							const expanded = open1 === entry.id;
							return (
								<li key={entry.id} style={styles.row}>
									<div style={styles.meta}>
										{clock(entry.at)} {'·'} {entry.kind} {'·'} {entrySummary(entry)} {'·'} {`round trip ${(entry.ms / 1000).toFixed(3)} s`}
										{entry.pinned && <> <StatusBadge variant="info">Pinned</StatusBadge></>}
									</div>
									<pre style={styles.text}>{expanded ? entry.cypher : entry.cypher.split('\n').slice(0, 3).join('\n')}</pre>
									{entry.truncated && <div style={styles.meta}>Saved text was cut to fit the size limit.</div>}
									{entry.note && <div style={styles.meta}>{`note: ${entry.note}`}</div>}
									{expanded && (
										<div style={{ marginTop: 6 }}>
											<InputField value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note" aria-label="Note for this statement" />
											<Button variant="ghost" small onClick={() => { void history.setNote(endpointKey, entry.id, note.trim()).then(() => announce('Note saved.'), failed('The note was not saved.')); }}>Save note</Button>
										</div>
									)}
									<div style={styles.actions}>
										<Button variant="ghost" small onClick={() => onLoad(entry.cypher)}>Load into editor</Button>
										<Button variant="ghost" small onClick={() => onRerun(entry.cypher)}>Run again</Button>
										<Button variant="ghost" small onClick={() => { void history.togglePin(endpointKey, entry.id).catch(failed(entry.pinned ? 'The entry was not unpinned.' : 'The entry was not pinned.')); }}>{entry.pinned ? 'Unpin' : 'Pin'}</Button>
										<Button variant="ghost" small ariaExpanded={expanded} onClick={() => { setOpen1(expanded ? null : entry.id); setNote(entry.note ?? ''); }}>{expanded ? 'Less' : 'More'}</Button>
										<Button variant="ghost" small onClick={() => { void history.removeEntry(endpointKey, entry.id).catch(failed('The entry was not deleted.')); }}>Delete</Button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</DetailPanel>
			{confirmClear && (
				<ConfirmDialog
					title="Clear history?"
					message={`Clear ${entries.length} entries for ${nodeName}? Pinned entries are removed too.`}
					confirmLabel="Clear"
					destructive
					onConfirm={() => { setConfirmClear(false); void history.clearForKey(endpointKey).then(() => announce('History cleared.'), failed('History was not cleared.')); }}
					onCancel={() => setConfirmClear(false)}
				/>
			)}
		</>
	);
};

export default HistoryPanel;
