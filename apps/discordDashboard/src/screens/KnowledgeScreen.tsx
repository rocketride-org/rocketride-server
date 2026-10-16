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
// KNOWLEDGE — what Ralph answers from, as documents a person can read
// =============================================================================
//
// A document browser over Ralph's knowledge base: the docs pages, the answers
// the team taught him, and the documents added here. No charts.
//
// THE LIST IS THE CATALOG, NOT THE STORE. The store nodes cannot list a
// collection, so the app keeps its own catalog (`dd_kb_documents`): seeded once
// with the docs pages and the taught answers, written by Teach Ralph when an
// answer lands, and written here when a document is added. It holds each
// document's full text, so reading one never depends on the vector store.
//
// THE ENGINE IS ASKED THREE THINGS (`src/kb/knowledge.ts`): search by meaning
// (the retrieval the grader uses), a document's chunks, and an add (Teach
// Ralph's own writeback). Each needs the engine connection on top of the
// database, so each carries a disabled reason of its own.
//
// ADDING IS FOR SIGNED-IN USERS — the Review tab's gating: the app is private,
// so being signed in and able to open it is the permission. There is no role
// check and no remove: this round deliberately has no delete anywhere.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DataGrid, DetailPanel, MarkdownRenderer, PanelTabBody, monoEl, mutedEl, useAuthUser, useShellConnection } from 'shell';
import type { GridColumnDefinition } from 'shell';
import type { KbDocument, KbSource } from '../db/repo';
import { addToKnowledgeBase, closenessOf, loadChunks, searchByMeaning, UPLOAD_TYPES, uploadName, type KbChunk, type MeaningHit } from '../kb/knowledge';
import { formatAge, formatWhen, Skeleton } from '../ui/parts';
import { Btn, Chip, DdBanner, DdCard, DdEmpty, FilterChip, PageHeader, shortWhen, Tabs } from '../ui/dd';
import { Icon } from '../ui/Icon';
import { useToast } from '../ui/toast';
import { reviewerNameOf } from './quality/ReviewTab';
import type { ScreenProps } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The sources, in the order the chips show them, with their words. */
const SOURCES: { id: KbSource; label: string; rank: 1 | 2 | 3 }[] = [
	{ id: 'corpus', label: 'Docs pages', rank: 1 },
	{ id: 'taught', label: 'Taught answers', rank: 2 },
	{ id: 'uploaded', label: 'Added here', rank: 3 },
];

/** One source in words, for a chip or a line. */
const SOURCE_LABEL: Record<KbSource, string> = {
	corpus: 'Docs page',
	taught: 'Taught answer',
	uploaded: 'Added here',
};

/** How many additions "Recent activity" lists. */
const RECENT_LIMIT = 5;

/** Longest snippet a search hit shows. */
const SNIPPET_LIMIT = 320;

/**
 * Above this many characters a document is shown as plain text rather than
 * rendered markdown: the release notes run to half a megabyte, and rendering
 * that as markdown freezes the drawer for seconds.
 */
const MARKDOWN_LIMIT = 120_000;

/** The add form's two ways in. */
const ADD_TABS = [
	{ id: 'paste', label: 'Paste text' },
	{ id: 'file', label: 'Upload a file' },
];

// =============================================================================
// TYPES
// =============================================================================

/** A meaning search, from asking to answer. */
type MeaningState = { status: 'idle' } | { status: 'loading'; query: string } | { status: 'done'; query: string; hits: MeaningHit[] } | { status: 'error'; query: string; error: string };

/** Something read on demand: a document's text, or its chunks. */
type Loadable<T> = { status: 'loading' } | { status: 'done'; value: T } | { status: 'error'; error: string };

/** Props for {@link KnowledgeScreen}. */
export interface KnowledgeScreenProps extends ScreenProps {
	/** The catalog, newest first. */
	kbDocuments: KbDocument[];
	/** A meaning search another screen asked for ("What Ralph retrieved"), or null. */
	pendingSearch: { text: string; nonce: number } | null;
	/** The pending search has been taken; clear it so a revisit does not re-run it. */
	onSearchConsumed: () => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/** The message of an unknown throw, never an empty string. */
function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The engine gave no reason.';
}

/** A size in words: `815 chars`, `3.4k chars`, `527k chars`. */
function sizeText(chars: number): string {
	if (chars < 1000) return `${chars} chars`;
	if (chars < 100_000) return `${(chars / 1000).toFixed(1)}k chars`;
	return `${Math.round(chars / 1000)}k chars`;
}

/** A PDF added here: the catalog holds its file name, not its text. */
function isPdf(document: KbDocument): boolean {
	return document.source === 'uploaded' && document.name.toLowerCase().endsWith('.pdf');
}

/** The source as a category chip DOM node, for the grid. */
function sourceEl(source: KbSource): HTMLElement {
	const el = document.createElement('span');
	el.className = 'dd-chip';
	const dot = document.createElement('span');
	dot.className = `dd-dot dd-fill-${SOURCES.find((entry) => entry.id === source)?.rank ?? 3}`;
	dot.setAttribute('aria-hidden', 'true');
	el.append(dot, document.createTextNode(SOURCE_LABEL[source]));
	return el;
}

/** The source as a category chip. */
const SourceChip: React.FC<{ source: KbSource }> = ({ source }) => (
	<span className="dd-chip">
		<span className={`dd-dot dd-fill-${SOURCES.find((entry) => entry.id === source)?.rank ?? 3}`} aria-hidden="true" />
		{SOURCE_LABEL[source]}
	</span>
);

/** Who added it and when, in one line. */
function addedLine(document: KbDocument): string {
	if (document.source === 'corpus') return `${shortWhen(document.addedAt)} · docs build`;
	return `${shortWhen(document.addedAt)} · by ${document.addedBy ?? 'unknown'}`;
}

/** A title for a document that has none. */
function titleOf(document: KbDocument): string {
	return document.title.trim().length > 0 ? document.title : document.name;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Knowledge screen.
 *
 * @param props - See {@link KnowledgeScreenProps}.
 * @returns The screen.
 */
export const KnowledgeScreen: React.FC<KnowledgeScreenProps> = ({ data, actions, loaded, sampleMode, dbStatus, dbError, writesBlocked, kbDocuments, pendingSearch, onSearchConsumed }) => {
	const toast = useToast();
	const { client, isConnected } = useShellConnection();
	const identity = useAuthUser();
	const who = reviewerNameOf(identity);
	const matchDistance = data.settings.eval.matchDistance;
	const now = Date.now();

	// --- List state -----------------------------------------------------------

	const [query, setQuery] = useState('');
	const [sources, setSources] = useState<KbSource[]>(['corpus', 'taught', 'uploaded']);
	const [meaning, setMeaning] = useState<MeaningState>({ status: 'idle' });

	// --- Document view state --------------------------------------------------

	const [openId, setOpenId] = useState<string | null>(null);
	const [content, setContent] = useState<Loadable<string | null>>({ status: 'loading' });
	const [showChunks, setShowChunks] = useState(false);
	const [chunks, setChunks] = useState<Loadable<KbChunk[]> | null>(null);

	// --- Add state ------------------------------------------------------------

	const [addOpen, setAddOpen] = useState(false);
	const [addMode, setAddMode] = useState<'paste' | 'file'>('paste');
	const [addTitle, setAddTitle] = useState('');
	const [addText, setAddText] = useState('');
	const [addFile, setAddFile] = useState<File | null>(null);
	const [adding, setAdding] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement | null>(null);

	// --- Why each engine action cannot run ------------------------------------

	const engineDown = !isConnected || !client ? 'Not connected to the engine' : null;
	const searchBlocked = sampleMode ? 'Turn off Sample data to search the knowledge base' : engineDown;
	const chunksBlocked = engineDown;
	const addBlocked = sampleMode ? 'Turn off Sample data to add documents' : (writesBlocked ?? engineDown ?? (who === null ? 'Sign in to add documents' : null));

	const byId = useMemo(() => new Map(kbDocuments.map((document) => [document.objectId, document])), [kbDocuments]);
	const openDoc = openId !== null ? (byId.get(openId) ?? null) : null;

	const counts = useMemo(() => {
		const out: Record<KbSource, number> = { corpus: 0, taught: 0, uploaded: 0 };
		for (const document of kbDocuments) out[document.source] += 1;
		return out;
	}, [kbDocuments]);

	// Newest first, then narrowed by the chips and the title box.
	const rows = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return kbDocuments
			.filter((document) => sources.includes(document.source))
			.filter((document) => needle.length === 0 || titleOf(document).toLowerCase().includes(needle))
			.slice()
			.sort((a, b) => b.addedAt - a.addedAt || titleOf(a).localeCompare(titleOf(b)));
	}, [kbDocuments, sources, query]);

	const recent = useMemo(
		() =>
			kbDocuments
				.filter((document) => document.source !== 'corpus')
				.slice()
				.sort((a, b) => b.addedAt - a.addedAt)
				.slice(0, RECENT_LIMIT),
		[kbDocuments]
	);

	// --- Search by meaning ----------------------------------------------------

	/** Run one meaning search. */
	async function runMeaning(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0 || !client || searchBlocked !== null) return;
		setMeaning({ status: 'loading', query: trimmed });
		try {
			const hits = await searchByMeaning(client, trimmed);
			setMeaning({ status: 'done', query: trimmed, hits });
		} catch (err) {
			setMeaning({ status: 'error', query: trimmed, error: reasonOf(err) });
		}
	}

	// "What Ralph retrieved": another screen asked for a search. Prefill it now,
	// run it as soon as the engine is there, and hand it back so a later visit
	// does not run it again.
	useEffect(() => {
		if (pendingSearch === null) return;
		setQuery(pendingSearch.text);
		// Sample mode will not change by waiting; a connection that is still
		// coming up will, so that case keeps the request until it can run.
		if (sampleMode) {
			onSearchConsumed();
			return;
		}
		if (searchBlocked !== null) return;
		onSearchConsumed();
		void runMeaning(pendingSearch.text);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingSearch, searchBlocked]);

	// --- The document view ----------------------------------------------------

	/** Open one document in the drawer. */
	function openDocument(objectId: string): void {
		setOpenId(objectId);
		setShowChunks(false);
		setChunks(null);
	}

	useEffect(() => {
		if (openId === null) return;
		let alive = true;
		setContent({ status: 'loading' });
		actions
			.readKbContent(openId)
			.then((value) => {
				if (alive) setContent({ status: 'done', value });
			})
			.catch((err: unknown) => {
				if (alive) setContent({ status: 'error', error: reasonOf(err) });
			});
		return () => {
			alive = false;
		};
	}, [openId, actions]);

	useEffect(() => {
		if (openId === null || !showChunks || !client || chunksBlocked !== null) return;
		let alive = true;
		setChunks({ status: 'loading' });
		loadChunks(client, openId)
			.then((value) => {
				if (alive) setChunks({ status: 'done', value });
			})
			.catch((err: unknown) => {
				if (alive) setChunks({ status: 'error', error: reasonOf(err) });
			});
		return () => {
			alive = false;
		};
	}, [openId, showChunks, client, chunksBlocked]);

	// --- Add document ---------------------------------------------------------

	/** Reset the form to empty. */
	function resetAdd(): void {
		setAddTitle('');
		setAddText('');
		setAddFile(null);
		setAddError(null);
		if (fileInput.current) fileInput.current.value = '';
	}

	/** Why the form cannot be submitted yet, or null. */
	const addIncomplete = addMode === 'paste' ? (addTitle.trim().length === 0 ? 'Give the document a title' : addText.trim().length === 0 ? 'Paste the text first' : null) : addFile === null ? 'Pick a file first' : null;

	/** Send the document, then catalogue it. */
	async function handleAdd(): Promise<void> {
		if (!client || addBlocked !== null || addIncomplete !== null || who === null) return;
		setAdding(true);
		setAddError(null);
		try {
			let title = addTitle.trim();
			let ext = 'md';
			let data: string | Uint8Array;
			let stored: string;
			if (addMode === 'paste') {
				// Teach Ralph's shape: the title as the H1, so a retrieved chunk
				// reads as part of something rather than as a loose fragment.
				data = `# ${title}\n\n${addText.trim()}\n`;
				stored = data;
			} else {
				const file = addFile as File;
				const dot = file.name.lastIndexOf('.');
				ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
				if (UPLOAD_TYPES[ext] === undefined) throw new Error('Pick a .md, .txt or .pdf file.');
				if (title.length === 0) title = dot > 0 ? file.name.slice(0, dot) : file.name;
				if (ext === 'pdf') {
					// The writeback returns the document's id and nothing else, so
					// the PDF's extracted text never comes back to the app: the
					// catalog keeps the file name, and the view says so.
					data = new Uint8Array(await file.arrayBuffer());
					stored = file.name;
				} else {
					data = await file.text();
					stored = data;
				}
			}
			const name = uploadName(title, ext);
			const objectId = await addToKnowledgeBase(client, name, data, UPLOAD_TYPES[ext]);
			await actions.addKbDocument({ objectId, name, title, source: 'uploaded', route: null, content: stored, addedBy: who, addedAt: Date.now() });
			toast.success(`Added “${title}” to Ralph’s knowledge base. He can use it on the next matching question.`);
			resetAdd();
			setAddOpen(false);
		} catch (err) {
			setAddError(reasonOf(err));
			toast.error(`Could not add the document: ${reasonOf(err)}`);
		} finally {
			setAdding(false);
		}
	}

	// --- The grid -------------------------------------------------------------

	const columns = useMemo(
		() =>
			[
				{
					title: 'Title',
					field: 'title',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'The page title, the question a taught answer is for, or the title it was added under. A docs page shows its route under the title.',
					headerSort: true,
					minWidth: 280,
					formatter: (cell) => {
						const row = cell.getRow().getData() as KbDocument;
						// Title over route: a docs page is known by both, and a column of
						// its own for the route would squeeze the title to nothing.
						const el = document.createElement('span');
						el.style.cssText = 'display:flex;flex-direction:column;justify-content:center;min-width:0;overflow:hidden;line-height:17px';
						el.title = row.route !== null ? `${titleOf(row)}\n${row.route}` : titleOf(row);
						const t = document.createElement('span');
						t.className = 'dd-cellq__t';
						t.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)';
						t.textContent = titleOf(row);
						el.append(t);
						if (row.route !== null) {
							const r = document.createElement('span');
							r.className = 'dd-mono';
							r.style.cssText = 'font-size:11px;color:var(--ink-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
							r.textContent = row.route;
							el.append(r);
						}
						return el;
					},
				},
				{
					title: 'Source',
					field: 'source',
					rrType: 'enum',
					rrDefault: true,
					rrOptions: SOURCES.map((entry) => ({ value: entry.id, label: SOURCE_LABEL[entry.id] })),
					rrDescription: 'A docs page, an answer the team taught Ralph, or a document added on this screen.',
					width: 150,
					headerSort: true,
					formatter: (cell) => sourceEl(cell.getValue() as KbSource),
				},
				{
					title: 'Docs route',
					field: 'route',
					rrType: 'string',
					rrDescription: 'Where a docs page lives on the docs site. Shown under the title; hidden as a column by default.',
					width: 220,
					headerSort: true,
					formatter: (cell) => {
						const value = cell.getValue();
						return typeof value === 'string' && value.length > 0 ? monoEl(value) : mutedEl('—');
					},
				},
				{
					title: 'Added',
					field: 'addedAt',
					rrType: 'date',
					rrDefault: true,
					rrDefaultSort: 'desc',
					rrDescription: 'When it reached the knowledge base, and who taught or added it.',
					width: 250,
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => {
						const row = cell.getRow().getData() as KbDocument;
						const el = mutedEl(addedLine(row));
						el.title = formatWhen(row.addedAt);
						return el;
					},
				},
				{
					title: 'Size',
					field: 'chars',
					rrType: 'number',
					rrDefault: true,
					rrDescription: 'Length of the stored text. A PDF added here keeps its file name, not its text.',
					width: 110,
					hozAlign: 'right',
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => {
						const row = cell.getRow().getData() as KbDocument;
						return mutedEl(isPdf(row) ? 'PDF' : sizeText(row.chars));
					},
				},
			] satisfies GridColumnDefinition[],
		[]
	);

	// --- LOADING --------------------------------------------------------------

	const subtitle = 'Everything Ralph answers from: the docs pages, the answers the team taught him, and documents added here.';

	if (!loaded) {
		return (
			<div className="dd-page">
				<PageHeader title="Knowledge" subtitle={subtitle} />
				<DdCard>
					<Skeleton rows={6} label="Loading the knowledge base catalog" />
				</DdCard>
			</div>
		);
	}

	const catalogDown = dbStatus === 'error' && kbDocuments.length === 0;

	// --- The search bar, the meaning action and the chips: one toolbar --------

	const toolbar = (
		<div className="dd-stack" style={{ width: '100%', gap: 10 }}>
			<div className="dd-filters">
				<label className="dd-search">
					<Icon name="search" />
					<span className="dd-sr">Search titles</span>
					<input
						className="dd-input"
						type="text"
						placeholder="Search titles, or describe what you need…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							// Typing filters titles as it goes; Enter asks by meaning.
							if (e.key === 'Enter') void runMeaning(query);
						}}
						style={{ width: 340 }}
					/>
				</label>
				<Btn icon="search" onClick={() => void runMeaning(query)} disabled={searchBlocked !== null || query.trim().length === 0 || meaning.status === 'loading'} title={searchBlocked ?? (query.trim().length === 0 ? 'Type what you are looking for first' : 'Find the documents closest in meaning, the way Ralph retrieves them')}>
					{meaning.status === 'loading' ? 'Searching…' : 'Search by meaning'}
				</Btn>
				<span className="dd-spacer" />
				<span className="dd-caption dd-num">
					{rows.length} of {kbDocuments.length}
				</span>
			</div>
			<div className="dd-row">
				{SOURCES.map((entry) => (
					<FilterChip key={entry.id} pressed={sources.includes(entry.id)} count={counts[entry.id]} onClick={() => setSources((prev) => (prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id]))}>
						{entry.label}
					</FilterChip>
				))}
			</div>
		</div>
	);

	// --- Meaning results ------------------------------------------------------

	const meaningCard =
		meaning.status === 'idle' ? null : (
			<DdCard
				title={`Closest in meaning to “${meaning.query.length > 80 ? `${meaning.query.slice(0, 79)}…` : meaning.query}”`}
				actions={
					<Btn variant="ghost" small onClick={() => setMeaning({ status: 'idle' })} disabled={meaning.status === 'loading'}>
						Clear
					</Btn>
				}
			>
				{meaning.status === 'loading' ? (
					<Skeleton rows={4} label="Searching the knowledge base" />
				) : meaning.status === 'error' ? (
					<DdBanner variant="error" title="The search did not run.">
						The list below still works; searching by meaning needs the engine. <span className="dd-caption">({meaning.error})</span>
					</DdBanner>
				) : meaning.hits.length === 0 ? (
					<DdEmpty icon="search" title="Nothing close enough came back" description="The knowledge base returned no passage for this. Try other words, or add the document Ralph is missing." />
				) : (
					<div className="dd-stack" style={{ gap: 10 }}>
						<p className="dd-help">
							Grouped by document, closest first — the passages Ralph would be handed for this question. <strong className="dd-strong">Closer</strong> is within the {matchDistance.toFixed(2)} distance at which the eval rules count the knowledge base as holding the answer; <strong className="dd-strong">further</strong> is past it.
						</p>
						<div className="dd-rowlist" style={{ maxHeight: 520, overflowY: 'auto' }}>
							{meaning.hits.map((hit) => {
								const known = byId.get(hit.objectId) ?? null;
								const close = closenessOf(hit.distance, matchDistance) === 'closer';
								const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
								return (
									<button key={hit.objectId} type="button" className="dd-rowitem" style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto', textAlign: 'left', width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line)', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={() => (known !== null ? openDocument(hit.objectId) : undefined)} title={known !== null ? 'Open this document' : 'This document is in the knowledge base but not in the catalog'}>
										<Chip tone={close ? 'ok' : 'neutral'} icon={close ? 'check' : 'minus'} title={`Distance ${hit.distance.toFixed(3)} — lower is closer`}>
											{close ? 'Closer' : 'Further'}
										</Chip>
										<span style={{ minWidth: 0 }}>
											<span className="dd-rowitem__q">{known !== null ? titleOf(known) : hit.parent || hit.objectId}</span>
											<span className="dd-rowitem__meta">
												{known !== null ? <SourceChip source={known.source} /> : <span className="dd-chip">Not in the catalog</span>}
												<span className="dd-num">distance {hit.distance.toFixed(2)}</span>
												<span>· {hit.chunks === 1 ? '1 passage' : `${hit.chunks} passages`} returned</span>
											</span>
											<span className="dd-help" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
												{snippet.length > SNIPPET_LIMIT ? `${snippet.slice(0, SNIPPET_LIMIT - 1)}…` : snippet || '(empty passage)'}
											</span>
										</span>
										<span className="dd-caption">{known !== null ? <Icon name="chevron" /> : null}</span>
									</button>
								);
							})}
						</div>
					</div>
				)}
			</DdCard>
		);

	// --- Add form -------------------------------------------------------------

	const addCard = addOpen ? (
		<DdCard
			title="Add a document"
			actions={
				<Btn variant="ghost" small onClick={() => setAddOpen(false)} disabled={adding}>
					Close
				</Btn>
			}
		>
			<div className="dd-stack" style={{ gap: 14 }}>
				<Tabs label="How to add it" items={ADD_TABS} active={addMode} onSelect={(id) => setAddMode(id as 'paste' | 'file')} />
				{addBlocked !== null && <DdBanner variant="warning">{addBlocked}. The list and the search still work.</DdBanner>}
				<label className="dd-stack" style={{ gap: 6 }}>
					<span className="dd-field__label">Title{addMode === 'file' ? ' (optional — the file name otherwise)' : ''}</span>
					<input className="dd-input" type="text" value={addTitle} disabled={adding} placeholder="What the document is about" onChange={(e) => setAddTitle(e.target.value)} />
				</label>
				{addMode === 'paste' ? (
					<label className="dd-stack" style={{ gap: 6 }}>
						<span className="dd-field__label">Text</span>
						<textarea className="dd-input" rows={10} value={addText} disabled={adding} placeholder="Paste the text Ralph should be able to answer from. Markdown is fine." onChange={(e) => setAddText(e.target.value)} />
					</label>
				) : (
					<label className="dd-stack" style={{ gap: 6 }}>
						<span className="dd-field__label">File — .md, .txt or .pdf</span>
						<input ref={fileInput} className="dd-input" type="file" accept=".md,.txt,.pdf,text/markdown,text/plain,application/pdf" disabled={adding} onChange={(e) => setAddFile(e.target.files?.[0] ?? null)} />
						<span className="dd-help">A PDF is read by the knowledge base, but its text does not come back to this app, so the catalog keeps only its file name.</span>
					</label>
				)}
				{addError !== null && (
					<DdBanner variant="error" title="The document was not added.">
						{addError}
					</DdBanner>
				)}
				<div className="dd-row">
					<Btn variant="primary" icon="upload" onClick={() => void handleAdd()} disabled={adding || addBlocked !== null || addIncomplete !== null} title={addBlocked ?? addIncomplete ?? 'Send it to Ralph’s knowledge base and list it here'}>
						{adding ? 'Adding to the knowledge base…' : 'Add to Ralph’s knowledge'}
					</Btn>
					<Btn
						variant="ghost"
						onClick={() => {
							resetAdd();
							setAddOpen(false);
						}}
						disabled={adding}
					>
						Cancel
					</Btn>
					<span className="dd-caption">Adding again under the same title replaces the earlier document. {who !== null ? `Added as ${who}.` : ''}</span>
				</div>
			</div>
		</DdCard>
	) : null;

	// --- Recent activity ------------------------------------------------------

	const recentCard = (
		<DdCard title="Recent activity">
			{catalogDown ? (
				<p className="dd-help">Unavailable while the database is unreachable.</p>
			) : recent.length === 0 ? (
				<DdEmpty icon="book" title="Nothing taught or added yet" description="Answers taught on the Review tab, and documents added here, show up first." />
			) : (
				<div className="dd-rowlist">
					{recent.map((document) => (
						<button key={document.objectId} type="button" className="dd-rowitem" style={{ gridTemplateColumns: 'minmax(0, 1fr)', textAlign: 'left', width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line)', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={() => openDocument(document.objectId)} title={formatWhen(document.addedAt)}>
							<span style={{ minWidth: 0 }}>
								<span className="dd-rowitem__q">{titleOf(document)}</span>
								<span className="dd-rowitem__meta">
									<span>{document.source === 'taught' ? 'Taught' : 'Added'}</span>
									<span>· by {document.addedBy ?? 'unknown'}</span>
									<span className="dd-num">· {formatAge(document.addedAt, now)}</span>
								</span>
							</span>
						</button>
					))}
				</div>
			)}
		</DdCard>
	);

	// --- The list -------------------------------------------------------------

	const list = catalogDown ? (
		<DdEmpty icon="database" title="The catalog cannot be read" description={`The dashboard database is unreachable, so the document list is too. Ralph's knowledge base itself is untouched. (${dbError ?? 'no reason given'})`} />
	) : kbDocuments.length === 0 ? (
		<DdEmpty icon="book" title="No documents catalogued yet" description="Seed the catalog with the docs pages and taught answers (see the README), or add a document." />
	) : rows.length === 0 ? (
		<DdEmpty
			icon="search"
			title="No document matches"
			description="No title contains this text with these sources on. Clear the search, turn a chip on, or search by meaning instead."
			action={
				<Btn
					onClick={() => {
						setQuery('');
						setSources(['corpus', 'taught', 'uploaded']);
					}}
				>
					Clear filters
				</Btn>
			}
		/>
	) : (
		<DataGrid<KbDocument> columns={columns} data={rows} tableId="discord-dashboard-knowledge" paginate={false} height="100%" onRowClick={(row) => openDocument(row.objectId)} emptyTitle="No documents" emptyDescription="Nothing in the catalog matches." />
	);

	// --- The drawer body ------------------------------------------------------

	const drawerBody =
		openDoc === null ? null : (
			<div className="dd-stack" style={{ gap: 18 }}>
				<div className="dd-row" style={{ padding: '10px 0 0' }}>
					<SourceChip source={openDoc.source} />
					<span className="dd-spacer" />
					<Btn small icon="sliders" pressed={showChunks} onClick={() => setShowChunks((value) => !value)} disabled={chunksBlocked !== null} title={chunksBlocked ?? (showChunks ? 'Back to the document text' : 'Show the passages the knowledge base stores and retrieves')}>
						{showChunks ? 'Hide chunks' : 'Show chunks'}
					</Btn>
				</div>
				<dl className="dd-dl">
					<dt>Added</dt>
					<dd className="dd-num">{openDoc.source === 'corpus' ? `${formatWhen(openDoc.addedAt)} · docs build` : `${formatWhen(openDoc.addedAt)} · by ${openDoc.addedBy ?? 'unknown'}`}</dd>
					{openDoc.route !== null && (
						<>
							<dt>Docs route</dt>
							<dd className="dd-mono">{openDoc.route}</dd>
						</>
					)}
					<dt>Size</dt>
					<dd className="dd-num">{isPdf(openDoc) ? 'PDF — the text is not kept in the catalog' : sizeText(openDoc.chars)}</dd>
					<dt>Stored as</dt>
					<dd className="dd-mono">{openDoc.name}</dd>
					<dt>Object id</dt>
					<dd className="dd-mono">{openDoc.objectId}</dd>
				</dl>

				{showChunks ? (
					chunks === null || chunks.status === 'loading' ? (
						<Skeleton rows={5} label="Loading the stored chunks" />
					) : chunks.status === 'error' ? (
						<DdBanner variant="error" title="The chunks could not be read.">
							The document text is still here — hide chunks to read it. <span className="dd-caption">({chunks.error})</span>
						</DdBanner>
					) : chunks.value.length === 0 ? (
						<DdEmpty icon="search" title="No chunks stored for this document" description="The catalog lists it, but the knowledge base holds no passages under its id — Ralph cannot retrieve it until it is sent again." />
					) : (
						<div className="dd-stack" style={{ gap: 12 }}>
							<span className="dd-eyebrow">{chunks.value.length === 1 ? '1 chunk' : `${chunks.value.length} chunks`} · what retrieval matches against</span>
							{chunks.value.map((chunk) => (
								<div key={chunk.chunkId} className="dd-stack" style={{ gap: 4 }}>
									<span className="dd-caption dd-num">
										Chunk {chunk.chunkId} · {sizeText(Array.from(chunk.text).length)}
									</span>
									<pre className="dd-pre" style={{ maxHeight: 360 }}>
										{chunk.text}
									</pre>
								</div>
							))}
						</div>
					)
				) : content.status === 'loading' ? (
					<Skeleton rows={8} label="Loading the document" />
				) : content.status === 'error' ? (
					<DdBanner variant="error" title="The document could not be read.">
						The catalog did not answer. <span className="dd-caption">({content.error})</span>
					</DdBanner>
				) : content.value === null || content.value.trim().length === 0 ? (
					<DdEmpty icon="inbox" title="No text stored" description="The catalog has no text for this document." />
				) : isPdf(openDoc) ? (
					<DdBanner variant="info" title="A PDF.">
						The knowledge base read <code>{content.value}</code>, but the writeback does not return a PDF's text, so only the file name is kept here. Show chunks to read what was stored.
					</DdBanner>
				) : content.value.length > MARKDOWN_LIMIT ? (
					<div className="dd-stack" style={{ gap: 8 }}>
						<span className="dd-caption">A long document, shown as plain text.</span>
						<p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.55 }}>{content.value}</p>
					</div>
				) : (
					<div className="dd-md">
						<MarkdownRenderer content={content.value} />
					</div>
				)}
			</div>
		);

	return (
		<div className="dd-page">
			<PageHeader
				title="Knowledge"
				subtitle={subtitle}
				actions={
					addOpen ? undefined : (
						<Btn variant="primary" icon="upload" onClick={() => setAddOpen(true)} disabled={addBlocked !== null} title={addBlocked ?? 'Paste text or upload a file for Ralph to answer from'}>
							Add document
						</Btn>
					)
				}
			/>
			{sampleMode && (
				<DdBanner variant="info" title="Sample data is on.">
					This is Ralph’s real knowledge base; searching by meaning and adding documents are off until you turn Sample data off in Settings &rsaquo; Advanced.
				</DdBanner>
			)}
			{!sampleMode && engineDown !== null && <DdBanner variant="warning">{engineDown}. The list and the documents still read; search by meaning, chunks and adding need the engine.</DdBanner>}

			{addCard}
			{meaningCard}

			{recentCard}

			<div style={{ minHeight: 520, height: 640, display: 'flex', flexDirection: 'column' }}>
				<DdCard toolbar={toolbar} flush fill>
					{list}
				</DdCard>
			</div>

			{openDoc !== null && (
				<div className="dd-drawer-scope">
					<DetailPanel open onClose={() => setOpenId(null)} title={titleOf(openDoc)} subtitle={`${SOURCE_LABEL[openDoc.source]} · ${openDoc.route ?? openDoc.name}`} width={640}>
						<PanelTabBody>{drawerBody}</PanelTabBody>
					</DetailPanel>
				</div>
			)}
		</div>
	);
};
