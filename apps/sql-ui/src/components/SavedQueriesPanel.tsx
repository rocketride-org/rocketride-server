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
// SQL-UI — SAVED QUERIES (named statements kept for this connection)
// =============================================================================
//
// Three pieces, each self-contained so the query header and the History
// drawer mount them with one line:
//
//   SaveQueryButton      "Save as query": names a statement (the name starts
//                        from its leading comment or first line) and keeps
//                        it. A refusal (a cap, nobody signed in) is shown in
//                        the dialog, word for word, and nothing is saved.
//   SavedQueriesButton   "Saved" in the query header: opens the drawer.
//   SavedQueriesPanel    a MODELESS right drawer, beside History: open,
//                        rename and delete. Open puts the query into a NEW
//                        query instance of the workbench and RUNS NOTHING:
//                        the statement waits there for Run.
//
// Where saved queries live depends on the mount (SqlEnv savedQueries), and
// the drawer's last line says where, every time it is open: the statement is
// stored as typed, literal values included.
// =============================================================================

import React, { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, ConfirmDialog, DetailPanel, EmptyState, InputField, Section } from 'shell';
import type { SqlEndpoint } from '../connect';
import { useSqlEnv } from '../sqlEnv';
import { useSqlPageNav } from '../pageNav';
import type { SqlQuerySeed } from '../pageNav';
import { MAX_SAVED_NAME_CHARS, MAX_SAVED_QUERIES, newSavedQuery, suggestQueryName } from '../history/savedQueries';
import type { SavedQuery } from '../history/savedQueries';
import { announce } from '../a11y/announce';
import { DatabaseIcon } from '../icons';

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

	field: {
		width: '100%',
	} as CSSProperties,

	form: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
	} as CSSProperties,

	label: {
		display: 'block',
		marginBottom: 4,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	row: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		padding: '10px 0',
		borderBottom: '1px solid var(--rr-bg-widget)',
	} as CSSProperties,

	name: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	} as CSSProperties,

	sql: {
		display: 'block',
		fontFamily: 'var(--rr-font-mono, monospace)',
		fontSize: 12.5,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,

	meta: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	error: {
		fontSize: 12,
		color: 'var(--rr-color-error)',
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
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The page seed Open hands the workbench: the statement and its name, and
 * nothing that would make it run or claim the app wrote it.
 *
 * @param query - The saved query.
 * @returns The seed for `pageNav.openQuery` (a NEW instance).
 */
export function openQuerySeed(query: SavedQuery): SqlQuerySeed {
	return { sql: query.sql, label: query.name };
}

/**
 * The first line with text, for the collapsed row.
 *
 * @param sql - The statement text.
 * @returns The line.
 */
function firstLine(sql: string): string {
	return sql.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
}

/**
 * When a query was saved, in the reader's locale.
 *
 * @param at - Epoch ms.
 * @returns e.g. "saved 27 Oct 2026, 14:02".
 */
function savedAt(at: number): string {
	return `saved ${new Date(at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * The sentence a failure carries.
 *
 * @param error - What was thrown.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// SAVE AS QUERY
// =============================================================================

/** Props for {@link SaveQueryButton}. */
export interface SaveQueryButtonProps {
	/** The connection the query is kept for. */
	endpoint: SqlEndpoint;
	/** The statement to keep, as typed. */
	sql: string;
	/** The small button (a History entry's actions). */
	small?: boolean;
}

/**
 * "Save as query": asks for a name, then keeps the statement for this
 * connection. Disabled while there is nothing to save.
 *
 * @param props - {@link SaveQueryButtonProps}.
 * @returns The button, and its dialog while open.
 */
export const SaveQueryButton: React.FC<SaveQueryButtonProps> = ({ endpoint, sql, small }) => {
	const saved = useSqlEnv().savedQueries;
	// The name being typed; null while the dialog is closed.
	const [name, setName] = useState<string | null>(null);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const empty = sql.trim() === '';

	/** Keep the statement under the typed name; a refusal stays in the dialog. */
	const save = async (): Promise<void> => {
		if (name === null || name.trim() === '' || saving) return;
		setSaving(true);
		setError('');
		try {
			await saved.save(endpoint, newSavedQuery(name.trim(), sql));
			setName(null);
			announce(`Saved as query: ${name.trim()}`);
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<Button
				variant="ghost"
				small={small}
				disabled={empty}
				title={empty ? 'Write a statement to save it.' : 'Keep this statement under a name, for this connection'}
				onClick={() => {
					setName(suggestQueryName(sql));
					setError('');
				}}
			>
				Save as query
			</Button>
			{name !== null && (
				<ConfirmDialog
					title="Save query"
					confirmLabel={saving ? 'Saving…' : 'Save'}
					confirmDisabled={saving || name.trim() === ''}
					onCancel={() => setName(null)}
					onConfirm={() => { void save(); }}
					message={
						<div style={styles.form}>
							<label>
								<span style={styles.label}>Name</span>
								<InputField
									style={styles.field}
									value={name}
									maxLength={MAX_SAVED_NAME_CHARS}
									autoFocus
									onChange={(event) => setName(event.target.value)}
									onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save(); }}
								/>
							</label>
							<div style={styles.meta}>Saved queries are kept per connection, for your account. A saved query keeps its text, not its results.</div>
							{error && <div role="alert" style={styles.error}>{error}</div>}
						</div>
					}
				/>
			)}
		</>
	);
};

// =============================================================================
// THE DRAWER
// =============================================================================

/** Props for {@link SavedQueriesPanel}. */
export interface SavedQueriesPanelProps {
	/** The connection whose saved queries are shown. */
	endpoint: SqlEndpoint;
	/** Whether the drawer is open. */
	open: boolean;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
}

/**
 * The per-connection saved-queries drawer: search, open, rename, delete.
 *
 * @param props - {@link SavedQueriesPanelProps}.
 * @returns The drawer element.
 */
export const SavedQueriesPanel: React.FC<SavedQueriesPanelProps> = ({ endpoint, open, onClose }) => {
	const pageNav = useSqlPageNav();
	const saved = useSqlEnv().savedQueries;
	const queries = saved.useSavedQueries(endpoint);
	const readState = saved.useReadState(endpoint);
	const privacyNotice = saved.usePrivacyNotice();

	const [search, setSearch] = useState('');
	const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
	const [confirmDelete, setConfirmDelete] = useState<SavedQuery | null>(null);
	const [error, setError] = useState('');

	const visible = useMemo(() => {
		const term = search.trim().toLowerCase();
		if (!term) return queries;
		return queries.filter((query) => query.name.toLowerCase().includes(term) || query.sql.toLowerCase().includes(term));
	}, [queries, search]);

	/**
	 * Open one query in a NEW query instance. Nothing runs: the statement
	 * waits in the editor for Run.
	 *
	 * @param query - The query to open.
	 */
	const openQuery = (query: SavedQuery): void => {
		pageNav.openQuery(openQuerySeed(query));
		onClose();
		announce(`Opened ${query.name} in a new query. Nothing has run.`);
	};

	/** Save the name being edited; a refusal is shown above the list. */
	const commitRename = async (): Promise<void> => {
		if (renaming === null) return;
		setError('');
		try {
			await saved.rename(endpoint, renaming.id, renaming.draft);
			setRenaming(null);
			announce('Saved query renamed');
		} catch (failure) {
			setError(messageOf(failure));
		}
	};

	/**
	 * Delete one query.
	 *
	 * @param query - The query to delete.
	 */
	const remove = async (query: SavedQuery): Promise<void> => {
		setError('');
		try {
			await saved.remove(endpoint, query.id);
			announce(`Deleted saved query ${query.name}`);
		} catch (failure) {
			setError(messageOf(failure));
		}
	};

	/**
	 * The list region: rows, or the empty state that says how to fill it.
	 *
	 * @returns The list content.
	 */
	const renderList = (): React.ReactNode => {
		// "None yet" only once a read has answered: before that, or after a
		// failed read, an empty list says nothing about what is saved.
		if (queries.length === 0 && readState.status === 'loading') {
			return <EmptyState icon={<DatabaseIcon />} title="Loading saved queries…" description="Reading this connection's saved queries." />;
		}
		if (queries.length === 0 && readState.status === 'failed') {
			return (
				<EmptyState
					icon={<DatabaseIcon />}
					title="Could not read saved queries"
					description={readState.message}
					action={<Button variant="secondary" small onClick={() => saved.retry(endpoint)}>Retry</Button>}
				/>
			);
		}
		if (queries.length === 0) {
			return (
				<EmptyState
					icon={<DatabaseIcon />}
					title="No saved queries yet"
					description="Save as query, in the query header or on a History entry, keeps a statement here under a name."
				/>
			);
		}
		if (visible.length === 0) return <EmptyState title="Nothing matches" description="No saved query matches this search." />;
		return visible.map((query) => {
			const editing = renaming?.id === query.id ? renaming : null;
			return (
				<div key={query.id} style={styles.row}>
					{editing ? (
						<InputField
							style={styles.field}
							aria-label={`New name for ${query.name}`}
							value={editing.draft}
							maxLength={MAX_SAVED_NAME_CHARS}
							autoFocus
							onChange={(event) => setRenaming({ id: query.id, draft: event.target.value })}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !event.nativeEvent.isComposing) void commitRename();
								if (event.key === 'Escape') setRenaming(null);
							}}
						/>
					) : (
						<span style={styles.name} title={query.name}>{query.name}</span>
					)}
					<span style={styles.sql} title={query.sql}>{firstLine(query.sql)}</span>
					<span style={styles.meta}>{savedAt(query.at)}</span>
					<div style={styles.actions}>
						{editing ? (
							<>
								<Button variant="primary" small disabled={editing.draft.trim() === ''} onClick={() => { void commitRename(); }}>Save name</Button>
								<Button variant="ghost" small onClick={() => setRenaming(null)}>Cancel</Button>
							</>
						) : (
							<>
								<Button variant="primary" small title="Open in a new query. Nothing runs until you press Run." onClick={() => openQuery(query)}>Open</Button>
								<Button variant="ghost" small onClick={() => { setError(''); setRenaming({ id: query.id, draft: query.name }); }}>Rename</Button>
								<Button variant="ghost" small onClick={() => setConfirmDelete(query)}>Delete</Button>
							</>
						)}
					</div>
				</div>
			);
		});
	};

	return (
		<>
			<DetailPanel
				open={open}
				onClose={onClose}
				modeless
				width={440}
				// The width rides the same preferences: kept only while they can be read.
				persistKey={readState.status === 'failed' ? undefined : 'sqlSavedQueriesWidth'}
				avatar={<span style={styles.avatar}><DatabaseIcon /></span>}
				title="Saved queries"
				subtitle={`${endpoint.nodeName} · this connection`}
			>
				<div style={styles.form}>
					<InputField
						type="search"
						style={styles.field}
						aria-label="Search saved queries"
						placeholder="Search names and statements"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					{error && <Banner variant="error">{error}</Banner>}
					{/* A list read before is still shown; the newest read failed. */}
					{queries.length > 0 && readState.status === 'failed' && (
						<Banner variant="warning">
							{`These may be out of date: ${readState.message}`}
							{' '}
							<Button variant="ghost" small onClick={() => saved.retry(endpoint)}>Retry</Button>
						</Banner>
					)}
				</div>

				<Section label={`Saved (${visible.length})`}>
					{renderList()}
				</Section>

				{queries.length >= MAX_SAVED_QUERIES && (
					<div style={styles.meta}>{`${queries.length} of ${MAX_SAVED_QUERIES} kept for this connection. Delete one to save another.`}</div>
				)}

				<div style={styles.notice}>{privacyNotice}</div>
			</DetailPanel>

			{confirmDelete && (
				<ConfirmDialog
					title="Delete saved query?"
					message={`Delete "${confirmDelete.name}"? The statement is not kept anywhere else.`}
					confirmLabel="Delete"
					destructive
					onCancel={() => setConfirmDelete(null)}
					onConfirm={() => {
						const query = confirmDelete;
						setConfirmDelete(null);
						void remove(query);
					}}
				/>
			)}
		</>
	);
};

// =============================================================================
// THE HEADER BUTTON
// =============================================================================

/**
 * "Saved" in the query header: opens this connection's saved queries.
 *
 * @param props - The connection.
 * @param props.endpoint - The connection whose saved queries are shown.
 * @returns The button and its drawer.
 */
export const SavedQueriesButton: React.FC<{ endpoint: SqlEndpoint }> = ({ endpoint }) => {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				variant="ghost"
				pressed={open}
				ariaExpanded={open}
				title="Show the queries saved for this connection"
				onClick={() => setOpen((was) => !was)}
			>
				Saved
			</Button>
			<SavedQueriesPanel endpoint={endpoint} open={open} onClose={() => setOpen(false)} />
		</>
	);
};

export default SavedQueriesPanel;
