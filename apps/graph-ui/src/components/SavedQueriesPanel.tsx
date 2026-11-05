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
// GRAPH-UI - SAVED QUERIES AND STARTER TEMPLATES (beside History)
// =============================================================================
//
// The body of the workbench's side panel when "Saved" is chosen (SidePanel holds
// it inline: no drawer, see there). Two lists:
//
//   Saved queries      this connection's, through env.userData: "Save current
//                      query" names the text of the query tab shown last (read
//                      when it is pressed: a tab's text re-renders nothing up
//                      here) and keeps it; each one opens in a new tab (not run), is
//                      inserted at the caret, renamed or deleted. A save the
//                      store refuses (a bound, nobody signed in) shows the
//                      store's own sentence and keeps nothing.
//   Starter templates  graph/templates.ts: reads filled from this connection's
//                      schema, offered per engine.
//
// Where saved queries are kept depends on the mount, and the panel says so in
// the store's own words (userData.privacyNote).
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, ConfirmDialog, InputField } from 'shell';
import { readErrorMessage } from 'shared/explorer';
import type { GraphDialect } from '../cypher/quote';
import { useGraphEnv, useSavedQueries } from '../env';
import { clipTitle } from '../graph/queryTabs';
import type { ISchemaView } from '../graph/schema';
import { starterTemplates } from '../graph/templates';
import type { ISavedQuery } from '../graph/userData';

/** Props. */
export interface ISavedQueriesPanelProps {
	endpointKey: string;
	nodeName: string;
	/** The schema the templates are filled from, or null before it was read. */
	schema: ISchemaView | null;
	dialect: GraphDialect | null;
	/** The query tab "Save current query" saves: its title and text, or null when no query tab is open. */
	current(): { title: string; text: string } | null;
	/** Open a query in a new tab, not run. */
	onOpen(name: string, cypher: string, origin: 'saved' | 'template'): void;
	/** Insert a query at the caret of the query tab shown last. */
	onInsert(cypher: string): void;
	announce(text: string): void;
}

const styles = {
	note: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: '0 0 10px' } as CSSProperties,
	section: { margin: '14px 0 4px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--rr-text-secondary)' } as CSSProperties,
	form: { display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 4px' } as CSSProperties,
	formRow: { display: 'flex', gap: 6, alignItems: 'center' } as CSSProperties,
	field: { flex: 1, minWidth: 0 } as CSSProperties,
	error: { fontSize: 12, color: 'var(--rr-color-error)' } as CSSProperties,
	list: { listStyle: 'none', padding: 0, margin: '6px 0 0' } as CSSProperties,
	row: { borderBottom: '1px solid var(--rr-border)', padding: '8px 0' } as CSSProperties,
	name: { fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as CSSProperties,
	text: { fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0' } as CSSProperties,
	actions: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } as CSSProperties,
};

/**
 * The first lines of a query, for its row.
 *
 * @param cypher - The query.
 * @returns At most three lines.
 */
function excerpt(cypher: string): string {
	return cypher.split('\n').slice(0, 3).join('\n');
}

/** Said when Save current query is pressed with no query tab open. */
export const NO_QUERY_TAB_TEXT = 'Nothing was saved: no query tab is open. Open one and write the query first.';

/** Said when Save current query is pressed on an empty tab. */
export const EMPTY_QUERY_TAB_TEXT = 'Nothing was saved: the query tab is empty.';

/**
 * What pressing Save current query starts: the name form for the tab's text as it is NOW, or why nothing can be saved.
 *
 * @param readTab - Reads the query tab shown last (its title and text), or null when there is none.
 * @returns The form's starting name and the text it saves, or the refusal.
 */
export function saveStart(readTab: () => { title: string; text: string } | null): { name: string; text: string } | { refusal: string } {
	const tab = readTab();
	if (tab === null) return { refusal: NO_QUERY_TAB_TEXT };
	if (tab.text.trim() === '') return { refusal: EMPTY_QUERY_TAB_TEXT };
	return { name: suggestedName(tab), text: tab.text };
}

/**
 * The name a save starts from: the tab's title when it is not a plain "Query N", else the query's first line.
 *
 * @param current - The tab.
 * @returns A name to edit.
 */
export function suggestedName(current: { title: string; text: string }): string {
	if (!/^Query \d+$/.test(current.title)) return current.title.replace(/ \(preview\)$/, '');
	const first = current.text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
	return clipTitle(first);
}

/**
 * The panel's body.
 *
 * @param props - See {@link ISavedQueriesPanelProps}.
 * @returns The two lists.
 */
export const SavedQueriesPanel: React.FC<ISavedQueriesPanelProps> = ({ endpointKey, nodeName, schema, dialect, current, onOpen, onInsert, announce }) => {
	const env = useGraphEnv();
	const view = useSavedQueries(endpointKey);
	const templates = useMemo(() => starterTemplates(schema, dialect), [schema, dialect]);
	// The save form: the name being typed and the text it saves (taken when the form opened); null while closed.
	const [saving, setSaving] = useState<{ name: string; text: string } | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [deleting, setDeleting] = useState<ISavedQuery | null>(null);
	const [error, setError] = useState('');
	const [search, setSearch] = useState('');

	const shown = useMemo(() => {
		const term = search.trim().toLowerCase();
		return term === '' ? view.queries : view.queries.filter((q) => q.name.toLowerCase().includes(term) || q.cypher.toLowerCase().includes(term));
	}, [view.queries, search]);

	const save = (): void => {
		if (saving === null || saving.name.trim() === '') return;
		const name = saving.name.trim();
		setError('');
		env.userData.editSaved(endpointKey, { action: 'save', name, cypher: saving.text }).then(
			() => {
				setSaving(null);
				announce(`Saved as ${name}.`);
			},
			(failure: unknown) => setError(readErrorMessage(failure))
		);
	};

	const rename = (): void => {
		if (renaming === null || renaming.name.trim() === '') return;
		const { id, name } = renaming;
		setError('');
		env.userData.editSaved(endpointKey, { action: 'rename', id, name: name.trim() }).then(
			() => {
				setRenaming(null);
				announce('Saved query renamed.');
			},
			(failure: unknown) => setError(readErrorMessage(failure))
		);
	};

	return (
		<>
			<div>
				<div style={styles.formRow}>
					<Button
						variant="secondary"
						small
						title="Keep the query in the query tab you were in last, under a name, for this connection"
						onClick={() => {
							const start = saveStart(current);
							if ('refusal' in start) {
								setSaving(null);
								setError(start.refusal);
								announce(start.refusal);
								return;
							}
							setError('');
							setSaving(start);
						}}
					>
						Save current query
					</Button>
				</div>
				{saving !== null && (
					<div style={styles.form}>
						<div style={styles.formRow}>
							<InputField
								style={styles.field}
								aria-label="Name of the saved query"
								placeholder="Name"
								value={saving.name}
								maxLength={120}
								autoFocus
								onChange={(event) => setSaving({ ...saving, name: event.target.value })}
								onKeyDown={(event) => {
									if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
										event.preventDefault();
										save();
									} else if (event.key === 'Escape') {
										event.preventDefault();
										setSaving(null);
									}
								}}
							/>
							<Button variant="primary" small disabled={saving.name.trim() === ''} onClick={save}>
								Save
							</Button>
							<Button variant="ghost" small onClick={() => setSaving(null)}>
								Cancel
							</Button>
						</div>
						<pre style={styles.text}>{excerpt(saving.text)}</pre>
					</div>
				)}
				{error !== '' && (
					<div role="alert" style={styles.error}>
						{error}
					</div>
				)}

				<h3 style={styles.section}>{`Saved (${view.queries.length})`}</h3>
				{view.note && <p style={styles.note}>{view.note}</p>}
				{view.queries.length > 3 && <InputField value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search saved queries" aria-label="Search saved queries" />}
				{view.status === 'loading' && view.queries.length === 0 ? (
					<p style={styles.note}>{'Reading the saved queries…'}</p>
				) : view.queries.length === 0 ? (
					<p style={styles.note}>None yet. Save current query keeps the text of the query tab shown last, under a name.</p>
				) : shown.length === 0 ? (
					<p style={styles.note}>No saved query matches the search.</p>
				) : (
					<ul style={styles.list}>
						{shown.map((query) => (
							<li key={query.id} style={styles.row}>
								{renaming?.id === query.id ? (
									<div style={styles.formRow}>
										<InputField
											style={styles.field}
											aria-label={`New name for ${query.name}`}
											value={renaming.name}
											maxLength={120}
											autoFocus
											onChange={(event) => setRenaming({ id: query.id, name: event.target.value })}
											onKeyDown={(event) => {
												if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
													event.preventDefault();
													rename();
												} else if (event.key === 'Escape') {
													event.preventDefault();
													setRenaming(null);
												}
											}}
										/>
										<Button variant="primary" small disabled={renaming.name.trim() === ''} onClick={rename}>
											Rename
										</Button>
									</div>
								) : (
									<div style={styles.name} title={query.name}>
										{query.name}
									</div>
								)}
								<pre style={styles.text}>{excerpt(query.cypher)}</pre>
								<div style={styles.actions}>
									<Button variant="ghost" small onClick={() => onOpen(query.name, query.cypher, 'saved')}>
										Open in new tab
									</Button>
									<Button variant="ghost" small onClick={() => onInsert(query.cypher)}>
										Insert
									</Button>
									<Button variant="ghost" small onClick={() => { setError(''); setRenaming({ id: query.id, name: query.name }); }}>
										Rename
									</Button>
									<Button variant="ghost" small onClick={() => setDeleting(query)}>
										Delete
									</Button>
								</div>
							</li>
						))}
					</ul>
				)}

				<h3 style={styles.section}>Starter templates</h3>
				<ul style={styles.list}>
					{templates.map((template) => (
						<li key={template.id} style={styles.row}>
							<div style={styles.name} title={template.name}>
								{template.name}
							</div>
							<pre style={styles.text}>{template.cypher}</pre>
							<div style={styles.actions}>
								<Button variant="ghost" small onClick={() => onOpen(template.name, template.cypher, 'template')}>
									Open in new tab
								</Button>
								<Button variant="ghost" small onClick={() => onInsert(template.cypher)}>
									Insert
								</Button>
							</div>
						</li>
					))}
				</ul>
				<p style={{ ...styles.note, marginTop: 12 }}>
					{/* privacyNote is '' in a dev-tool frame until the sidebar has answered: only the template line then. */}
					{[env.userData.privacyNote, schema && schema.labels.length > 0 ? 'Templates use the labels and relationship types of this connection.' : 'Templates that name a label appear once the schema has been read.'].filter((line) => line !== '').join(' ')}
				</p>
			</div>
			{deleting && (
				<ConfirmDialog
					title="Delete saved query?"
					message={`Delete "${deleting.name}" from the saved queries of ${nodeName}?`}
					confirmLabel="Delete"
					destructive
					onConfirm={() => {
						const query = deleting;
						setDeleting(null);
						env.userData.editSaved(endpointKey, { action: 'delete', id: query.id }).then(
							() => announce(`Deleted ${query.name}.`),
							(failure: unknown) => setError(readErrorMessage(failure))
						);
					}}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</>
	);
};

export default SavedQueriesPanel;
