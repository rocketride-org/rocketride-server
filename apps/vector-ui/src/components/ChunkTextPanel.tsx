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
// VECTOR-UI — ChunkTextPanel (a chunk's full text, in the point inspector)
// =============================================================================
//
// The selected chunk's full text beside the map, at most 20,000 characters,
// with the active query's words marked, "Lexical matches only; retrieval is
// by meaning", and Previous / Next chunk. The marks are text segments
// (vector/highlight.ts) rendered as <mark> elements whose children are text,
// so nothing in a chunk is ever interpreted as HTML.
//
// The text comes from `chunks {object_id, after_chunk: id - 1, limit: 1}`,
// as the map's light mode already asks it, and is fetched ONCE per key: the
// texts are kept per connection and sample in a small bounded cache that the
// registry empties on a change of identity ('chunk text'), so a second look,
// or two asks in flight together, cost no second call. The connection is
// part of the scope because the node derives a sample id from the seed and
// the keys alone: one corpus in two stores, sampled with the same seed, has
// one sample id on both.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { IRoleChannel } from 'shared/explorer';
import { connectionCaches } from '../adapters/explorer';
import type { ChunkTextPanelProps as ContractChunkTextPanelProps, IChunksResult, ToolOutcome, VectorKey } from '../contract/types';
import { callTool } from '../map/calls';
import { CHUNK_LEXICAL, CHUNK_LOADING, CHUNK_NO_MATCH, CHUNK_NO_QUERY, CHUNK_TRUNCATED, chunkMatchesLine, chunkMissing } from '../map/reviewWording';
import { MAP_STYLES } from '../map/styles';
import { ACCENT_TOKEN } from '../map/tokens';
import { clampText, highlightSegments, markedWords, queryWords } from '../vector/highlight';

// =============================================================================
// FETCHING THE TEXT (once per key)
// =============================================================================

/** A chunk's text as the panel shows it. */
export interface IChunkText {
	text: string;
	/** The chunk is longer than the panel shows. */
	truncated: boolean;
}

/** Fetch one chunk's text (the map binds it to its channel and store node). */
export type LoadChunkText = (key: VectorKey) => Promise<ToolOutcome<IChunkText>>;

/**
 * The `chunks` input that returns exactly one chunk.
 *
 * @param key - The chunk.
 * @returns The input.
 */
export function chunkTextInput(key: VectorKey): { object_id: string; after_chunk: number; limit: number } {
	return { object_id: key[0], after_chunk: key[1] - 1, limit: 1 };
}

/**
 * The text of one chunk in a `chunks` answer.
 *
 * @param result - The answer.
 * @param key - The chunk asked for.
 * @returns Its text (cut to CHUNK_TEXT_MAX), or null when the answer holds another chunk.
 */
export function readChunkText(result: IChunksResult, key: VectorKey): IChunkText | null {
	const item = result.items.find((c) => c.chunkId === key[1]);
	return item ? clampText(item.content) : null;
}

/**
 * Fetch one chunk's text from the store node through map/calls.ts.
 *
 * @param channel - The channel that reaches the store node.
 * @param storeNode - The store node id.
 * @param key - The chunk.
 * @returns The text, or the code and sentence of the failure.
 */
export async function fetchChunkText(channel: Pick<IRoleChannel, 'invoke'>, storeNode: string, key: VectorKey): Promise<ToolOutcome<IChunkText>> {
	const answer = await callTool<IChunksResult>(channel, 'chunks', chunkTextInput(key), { nodeId: storeNode });
	if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };
	const text = readChunkText(answer.value, key);
	return text ? { ok: true, value: text } : { ok: false, code: 'NOT_FOUND', message: chunkMissing(key[1]) };
}

/**
 * The cache scope of a sample's texts: its connection and its sample id, so
 * two stores holding one corpus never share a text.
 *
 * @param connectionKey - The connection, or none (the sample alone scopes the texts).
 * @param sampleId - The sample.
 * @returns The scope.
 */
export function chunkTextScope(connectionKey: string | null | undefined, sampleId: string): string {
	return JSON.stringify([connectionKey ?? '', sampleId]);
}

/** A bounded cache of chunk texts per scope (chunkTextScope); a failure is never kept. */
export interface IChunkTextCache {
	/** The text of a key, asking `fetch` only when it is neither kept nor on its way. */
	load(scope: string, key: VectorKey, fetch: LoadChunkText): Promise<ToolOutcome<IChunkText>>;
	/** A kept text, or undefined. */
	peek(scope: string, key: VectorKey): IChunkText | undefined;
	/** Forget every text (and drop every answer still on its way). */
	clear(): void;
	/** Forget one connection's texts (and drop its answers still on their way; other connections' are kept). */
	forget(connectionKey: string): void;
}

/**
 * Create a chunk text cache.
 *
 * @param max - Most texts kept (the oldest goes first).
 * @returns The cache.
 */
export function createChunkTextCache(max = 64): IChunkTextCache {
	const kept = new Map<string, IChunkText>();
	const pending = new Map<string, Promise<ToolOutcome<IChunkText>>>();
	const id = (scope: string, key: VectorKey): string => `${scope}\u0000${key[0]}#${key[1]}`;
	return {
		load(scope, key, fetch) {
			const k = id(scope, key);
			const hit = kept.get(k);
			if (hit) {
				kept.delete(k);
				kept.set(k, hit);
				return Promise.resolve({ ok: true, value: hit });
			}
			const flying = pending.get(k);
			if (flying) return flying;
			const run: Promise<ToolOutcome<IChunkText>> = fetch(key)
				.catch((error: unknown): ToolOutcome<IChunkText> => ({ ok: false, code: undefined, message: error instanceof Error ? error.message : String(error) }))
				.then((outcome) => {
					// A load still pending was neither forgotten nor cleared while it ran: only then is its answer kept.
					const current = pending.get(k) === run;
					if (current) pending.delete(k);
					if (outcome.ok && current) {
						kept.set(k, outcome.value);
						while (kept.size > max) kept.delete(kept.keys().next().value as string);
					}
					return outcome;
				});
			pending.set(k, run);
			return run;
		},
		peek(scope, key) {
			return kept.get(id(scope, key));
		},
		clear() {
			kept.clear();
			pending.clear();
		},
		forget(connectionKey) {
			// Scopes are chunkTextScope's JSON pairs, so one connection's start with its key as the first element.
			const prefix = JSON.stringify([connectionKey]).slice(0, -1) + ',';
			for (const map of [kept, pending] as const) for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
		},
	};
}

/** The inspector's chunk texts (per connection and sample, bounded), emptied on a change of identity. */
export const chunkTexts = createChunkTextCache();

connectionCaches.register('chunk text', () => chunkTexts.clear(), (key) => chunkTexts.forget(key));

// =============================================================================
// THE PANEL
// =============================================================================

/** Props: the lane's own (the frozen shape plus the chunk's words and bounds). */
export interface ChunkTextPanelProps extends ContractChunkTextPanelProps {
	/** Words for the chunk, e.g. "C:/demo/a.md #3". */
	label?: string;
	/** The text was cut to 20,000 characters. */
	truncated?: boolean;
	/** Whether there is a chunk before (default: chunk id above 0). */
	hasPrevious?: boolean;
	/** Whether to offer the next chunk (default: yes). */
	hasNext?: boolean;
}

/** How a marked word looks: bold and underlined, so colour is not the only carrier. */
const MARK_STYLE: React.CSSProperties = { background: 'transparent', color: 'inherit', fontWeight: 700, textDecoration: 'underline', textDecorationColor: `var(${ACCENT_TOKEN}, currentColor)`, textDecorationThickness: 2, textUnderlineOffset: 2 };

/**
 * The chunk text panel.
 *
 * @param props - The chunk, its text (null while it loads), the query, the step and close handlers.
 * @returns The panel.
 */
export function ChunkTextPanel(props: ChunkTextPanelProps): React.ReactElement {
	const terms = queryWords(props.query);
	const segments = props.text === null ? [] : highlightSegments(props.text, props.query);
	const marks = markedWords(segments);
	const hasPrevious = props.hasPrevious ?? props.chunkKey[1] > 0;
	const hasNext = props.hasNext ?? true;
	const label = props.label ?? `#${props.chunkKey[1]}`;
	return (
		<section aria-label="Chunk text" data-component="ChunkTextPanel" data-chunk={`${props.chunkKey[0]}#${props.chunkKey[1]}`} data-marks={marks} style={{ border: '1px solid var(--rr-border)', borderRadius: 6, padding: '6px 8px', margin: '6px 0' }}>
			<div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
				<span style={{ ...MAP_STYLES.label, wordBreak: 'break-all' }}>Full text · {label}</span>
				{props.onClose ? (
					<button type="button" style={MAP_STYLES.button} onClick={() => props.onClose?.()}>
						Close
					</button>
				) : null}
			</div>
			{props.error ? (
				<p style={MAP_STYLES.note}>{props.error}</p>
			) : props.text === null ? (
				<p style={MAP_STYLES.note} role="status">
					{CHUNK_LOADING}
				</p>
			) : (
				<>
					<div role="region" aria-label={`Text of ${label}`} tabIndex={0} style={{ ...MAP_STYLES.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto', margin: '6px 0', padding: '4px 6px', background: 'var(--rr-bg-default)', borderRadius: 4 }}>
						{segments.map((segment, i) =>
							segment.mark ? (
								<mark key={i} style={MARK_STYLE}>
									{segment.text}
								</mark>
							) : (
								<React.Fragment key={i}>{segment.text}</React.Fragment>
							)
						)}
					</div>
					{props.truncated ? <p style={MAP_STYLES.note}>{CHUNK_TRUNCATED}</p> : null}
					{terms.length === 0 ? (
						<p style={MAP_STYLES.note}>{CHUNK_NO_QUERY}</p>
					) : (
						<>
							<p style={MAP_STYLES.note}>{marks === 0 ? CHUNK_NO_MATCH : chunkMatchesLine(marks, terms)}</p>
							<p style={MAP_STYLES.note}>{CHUNK_LEXICAL}</p>
						</>
					)}
				</>
			)}
			{props.onPrevious || props.onNext ? (
				<div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
					<button type="button" style={MAP_STYLES.button} disabled={!props.onPrevious || !hasPrevious} onClick={() => props.onPrevious?.()}>
						Previous chunk
					</button>
					<button type="button" style={MAP_STYLES.button} disabled={!props.onNext || !hasNext} onClick={() => props.onNext?.()}>
						Next chunk
					</button>
				</div>
			) : null}
		</section>
	);
}

// =============================================================================
// THE INSPECTOR'S SECTION (the Show full text button and the panel)
// =============================================================================

/** Props of the inspector's text section. */
export interface ChunkTextSectionProps {
	/** The connection the sample was drawn from (with the sample id, the cache's scope). */
	connectionKey?: string;
	/** The sample the point belongs to. */
	sampleId: string;
	/** The selected chunk. */
	chunkKey: VectorKey;
	/** Words for a chunk of the selected document. */
	label: string;
	/** The active query, whose words are marked. */
	query: string | null;
	/** Fetch a chunk's text; with it the panel steps through the document. */
	loadText?: LoadChunkText;
	/** Tell the host the text is wanted (a host that fetches it itself passes `hostText`). */
	onShowText?(key: VectorKey): void;
	/** The host's text of the selected chunk, when it fetches it itself. */
	hostText?: string | null;
	/** Open at first render (a host restoring it; the tests). */
	initialOpen?: boolean;
	/** Words for another chunk of the same document. */
	labelOf?(key: VectorKey): string;
	/** The document's stored chunk count, when known: Next chunk stops at its last chunk. */
	chunks?: number | null;
}

/** What the section shows for its current chunk. */
type Loaded = { text: IChunkText | null; error: string | null };

/**
 * Show full text, and the panel once asked: it follows the selected point,
 * and with a loader steps to the previous or next chunk of the document.
 *
 * @param props - The chunk, the cache scope, the query and how to get the text.
 * @returns The button and, when open, the panel.
 */
export function ChunkTextSection(props: ChunkTextSectionProps): React.ReactElement | null {
	const { loadText } = props;
	const scope = chunkTextScope(props.connectionKey, props.sampleId);
	const [open, setOpen] = useState(props.initialOpen === true);
	const [key, setKey] = useState<VectorKey>(props.chunkKey);
	const [loaded, setLoaded] = useState<Loaded>(() => ({ text: loadText ? (chunkTexts.peek(scope, props.chunkKey) ?? null) : null, error: null }));
	const asked = useRef('');
	const selected = `${props.chunkKey[0]}#${props.chunkKey[1]}`;

	// A new selected point: the panel follows it.
	useEffect(() => {
		setKey(props.chunkKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected]);

	// Open on a chunk: fetch its text once (the cache answers repeats).
	const current = `${key[0]}#${key[1]}`;
	useEffect(() => {
		if (!open) return;
		props.onShowText?.(key);
		if (!loadText) return;
		// Whatever was asked before is no longer wanted, even when this key is already kept.
		asked.current = `${scope}|${current}`;
		const hit = chunkTexts.peek(scope, key);
		if (hit) {
			setLoaded({ text: hit, error: null });
			return;
		}
		setLoaded({ text: null, error: null });
		const mine = asked.current;
		void chunkTexts.load(scope, key, loadText).then((outcome) => {
			if (asked.current !== mine) return;
			setLoaded(outcome.ok ? { text: outcome.value, error: null } : { text: null, error: outcome.code === 'NOT_FOUND' ? chunkMissing(key[1]) : outcome.message });
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, current, scope]);

	const onSelected = current === selected;
	const text: IChunkText | null = loadText ? loaded.text : onSelected && props.hostText ? clampText(props.hostText) : null;
	const label = onSelected ? props.label : (props.labelOf?.(key) ?? `${props.label.replace(/ #\d+$/, '')} #${key[1]}`);
	return (
		<div>
			<button type="button" style={{ ...MAP_STYLES.button, marginTop: 4 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				{open ? 'Hide full text' : 'Show full text'}
			</button>
			{open ? <ChunkTextPanel chunkKey={key} label={label} text={text?.text ?? null} truncated={text?.truncated ?? false} query={props.query} error={loadText ? loaded.error : null} onPrevious={loadText ? () => setKey([key[0], Math.max(0, key[1] - 1)]) : undefined} onNext={loadText ? () => setKey([key[0], key[1] + 1]) : undefined} hasNext={typeof props.chunks === 'number' ? key[1] < props.chunks - 1 : undefined} onClose={() => setOpen(false)} /> : null}
		</div>
	);
}

export default ChunkTextPanel;
