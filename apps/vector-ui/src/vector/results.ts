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
// VECTOR - RESULTS (pure): what the app reads out of each tool answer
// =============================================================================
//
// Every vector tool answers `{success: true, ...}` or a failure envelope
// `{success: false, code, error}`; it never raises past the tool boundary.
// `unwrapEnvelope` turns an envelope into an ExplorerToolError of kind `store`
// that keeps the code. The readers below take a success answer and return
// exactly what the console shows, and refuse what they cannot read:
//
//   - The legacy `stats` keys (`count`, `model`, `vector_size`) are never read
//     as a document or chunk count: `count` is the raw row count including the
//     control record, shown in a tooltip only. An older node answering only the
//     legacy keys has no figures (null), never estimated ones.
//   - A missing collection keeps the legacy success envelope
//     (`count: 0, model: '', vector_size: 0, collection_exists: false`): '' is
//     no model and 0 is no dimension.
//   - `list_documents` is a LIST page; a dict is refused. The control record
//     (`schema`) is never listed, whatever a node sends.
//   - A number that is not a finite number is no count (null).
// =============================================================================

import { ExplorerToolError, isPlainObject } from 'shared/explorer';
import { CONTROL_OBJECT_ID } from '../contract/types';
import type { FilterApplied, IChunkItem, IDialectResult, IDocumentItem, IVectorLimits } from '../contract/types';

// =============================================================================
// ENVELOPE
// =============================================================================

/**
 * Return a success answer, or throw the failure envelope as a store error with its code.
 *
 * @param tool - The tool that answered.
 * @param value - Its answer.
 * @returns The answer, typed by the caller.
 */
export function unwrapEnvelope<T>(tool: string, value: unknown): T {
	if (!isPlainObject(value)) {
		throw new ExplorerToolError({ kind: 'malformed', tool, message: `${tool} answered with ${Array.isArray(value) ? 'a list' : value === null ? 'null' : typeof value}, not an object` });
	}
	if (value.success === false) {
		const error = typeof value.error === 'string' && value.error.trim() !== '' ? value.error : `${tool} reported a failure without saying why.`;
		throw new ExplorerToolError({ kind: 'store', tool, message: error, ...(typeof value.code === 'string' && value.code !== '' ? { code: value.code } : {}) });
	}
	return value as T;
}

// =============================================================================
// SMALL READERS
// =============================================================================

/** A finite number, else null. */
function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-negative integer count, else null. */
function count(value: unknown): number | null {
	const n = num(value);
	return n !== null && n >= 0 ? n : null;
}

/** A non-empty string, else null. */
function str(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** A list of strings (other entries dropped). */
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// =============================================================================
// DIALECT
// =============================================================================

/**
 * The limits the node enforces when its `dialect` does not publish them: the
 * contract's values (packages/ai/src/ai/common/store/vx_defaults.py
 * VECTOR_TOOL_LIMITS, pinned by tests against tests/fixtures/defaults.json).
 */
export const DEFAULT_LIMITS: Readonly<IVectorLimits> = {
	documents_page: 500,
	chunks_page: 200,
	vectors_keys_max: 2,
	sample_default: 1000,
	sample_max: 2000,
	sample_max_light: 5000,
	snippet_chars: 120,
	knn_k_max: 30,
	neighbors_k_max: 50,
	project_keys_max: 200,
	scope_keys_max: 2000,
	top_k_max: 100,
	write_ids_max: 100,
	sample_budget_ms: 60000,
	statement_timeout_ms: 30000,
	counts_cached_s: 60,
	recommend_examples_max: 10,
	matrix_keys_max: 100,
	max_components: 200,
};

/**
 * The node's `dialect` answer, normalised, or null when it is not a vector store's.
 *
 * @param info - The probe's answer.
 * @returns The dialect with every field present (absent ones read as off, empty or default).
 */
export function readDialect(info: Record<string, unknown> | null | undefined): IDialectResult | null {
	if (!isPlainObject(info) || info.dialect !== 'vector' || info.success === false) return null;
	const limitsIn = isPlainObject(info.limits) ? info.limits : {};
	const limits = { ...DEFAULT_LIMITS };
	for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof IVectorLimits>) {
		const value = limitsIn[key];
		if (key === 'statement_timeout_ms' && value === null) limits.statement_timeout_ms = null;
		else if (num(value) !== null && (value as number) > 0) (limits as Record<string, number | null>)[key] = value as number;
	}
	const capabilities: IDialectResult['capabilities'] = {};
	if (isPlainObject(info.capabilities)) {
		for (const [key, value] of Object.entries(info.capabilities)) {
			if (typeof value === 'boolean') (capabilities as Record<string, boolean>)[key] = value;
			else if (key === 'projection') capabilities.projection = strings(value);
		}
	}
	const health = isPlainObject(info.health) ? info.health : {};
	const score = isPlainObject(info.score) ? info.score : {};
	const index = isPlainObject(info.index) && typeof info.index.type === 'string' ? { type: info.index.type, ...(isPlainObject(info.index.params) ? { params: info.index.params } : {}) } : null;
	const metric = info.metric === 'cosine' || info.metric === 'l2' || info.metric === 'ip' ? info.metric : null;
	return {
		success: true,
		dialect: 'vector',
		contract: str(info.contract) ?? 'vector/1',
		provider: str(info.provider) ?? '',
		backend: str(info.backend) ?? '',
		backend_version: str(info.backend_version),
		collection: str(info.collection),
		metric,
		model: str(info.model),
		dimension: count(info.dimension) || null,
		index,
		score: {
			formula: str(score.formula) ?? 'unknown',
			...(Array.isArray(score.range) && score.range.length === 2 ? { range: [Number(score.range[0]), Number(score.range[1])] as [number, number] } : {}),
			higher_is_better: score.higher_is_better !== false,
			floor: num(score.floor) ?? 0.2,
			threshold: num(score.threshold),
		},
		support: info.support === 'supported' ? 'supported' : 'experimental',
		allow_writes: info.allow_writes === true,
		writes_scope: str(info.writes_scope) ?? 'tools_source',
		write_tools: strings(info.write_tools),
		capabilities,
		limits,
		health: {
			collection_exists: health.collection_exists === true,
			control_record: typeof health.control_record === 'boolean' ? health.control_record : null,
			model_mismatch: typeof health.model_mismatch === 'boolean' ? health.model_mismatch : null,
			meta_column: typeof health.meta_column === 'boolean' ? health.meta_column : null,
		},
		caveats: strings(info.caveats),
		// Additive keys (contract section 4.4-F/G): kept only when the node sent them.
		...('size_bytes' in info ? { size_bytes: count(info.size_bytes) } : {}),
		...('keyword_match' in info ? { keyword_match: info.keyword_match === 'substring' || info.keyword_match === 'token' ? info.keyword_match : null } : {}),
	};
}

// =============================================================================
// STATS
// =============================================================================

/** A `stats` answer as the strip shows it. */
export interface IStatsView {
	/** Legacy `count` (raw rows including the control record): the Chunks tooltip only. */
	legacyCount: number | null;
	model: string | null;
	/** True when the collection exists, or the node does not say (an older node). */
	collectionExists: boolean;
	documents: number | null;
	withoutFirstChunk: number | null;
	chunks: number | null;
	deleted: number | null;
	/** Documents with a chunk in the trash (the Trash listing's size), or null where the store cannot count. */
	deletedDocuments: number | null;
	rawCount: number | null;
	tables: number | null;
	avgPerDocument: number | null;
	dimension: number | null;
	metric: string | null;
	/** The index, when the answer carries one (the drawer falls back to it while the dialect has none). */
	index: { type: string; params?: Record<string, unknown> } | null;
	computedAt: string | null;
	countsAsOf: string | null;
	caveats: string[];
	/** True when the node answered the legacy keys only (an older node). */
	legacyOnly: boolean;
}

/**
 * Read a `stats` success answer.
 *
 * @param value - The answer (already unwrapped).
 * @returns The figures; null where the store did not count.
 */
export function readStats(value: Record<string, unknown>): IStatsView {
	const extended = ['documents', 'chunks', 'raw_count', 'collection_exists', 'computed_at'].some((key) => key in value);
	const vectorSize = count(value.vector_size);
	return {
		legacyCount: count(value.count),
		model: str(value.model),
		collectionExists: value.collection_exists !== false,
		documents: count(value.documents),
		withoutFirstChunk: count(value.documents_without_first_chunk),
		chunks: count(value.chunks),
		deleted: count(value.deleted_chunks),
		deletedDocuments: count(value.deleted_documents),
		rawCount: count(value.raw_count),
		tables: count(value.tables),
		avgPerDocument: count(value.avg_chunks_per_document),
		dimension: count(value.dimension) || vectorSize || null,
		metric: str(value.metric),
		index: isPlainObject(value.index) && typeof value.index.type === 'string' ? { type: value.index.type, ...(isPlainObject(value.index.params) ? { params: value.index.params } : {}) } : null,
		computedAt: str(value.computed_at),
		countsAsOf: str(value.counts_as_of),
		caveats: strings(value.caveats),
		legacyOnly: !extended,
	};
}

// =============================================================================
// DOCUMENTS
// =============================================================================

/** A `list_documents` page as the directory reads it. */
export interface IDocumentsPageView {
	items: IDocumentItem[];
	nextCursor: string | null;
	total: number | null;
	countsExact: boolean;
	distinct: boolean;
	/** False: the store listed in storage order; the directory sorts what is loaded. */
	sorted: boolean;
	caveats: string[];
	warnings: string[];
	/** The store ignored the page offset: the listing ends here (caveat documents_paging_unsupported). */
	pagingUnsupported: boolean;
	/** With a `filter`: how much of it the store applied (contract section 4.4-A); absent when the answer does not say. */
	filterApplied?: FilterApplied;
	/** The filter keys the store did not apply. */
	filterIgnored?: string[];
}

/**
 * One document row, or null when it has no objectId.
 *
 * @param raw - A row of `items`.
 * @returns The row with every field present.
 */
function readDocument(raw: unknown): IDocumentItem | null {
	if (!isPlainObject(raw)) return null;
	const objectId = str(raw.objectId);
	if (objectId === null || objectId === CONTROL_OBJECT_ID) return null;
	return {
		objectId,
		path: typeof raw.path === 'string' ? raw.path : '',
		chunks: count(raw.chunks),
		has_first_chunk: raw.has_first_chunk !== false,
		tables: count(raw.tables),
		deleted: raw.deleted === true,
		nodeId: str(raw.nodeId),
		size: count(raw.size),
		modifyTime: num(raw.modifyTime),
		ingestedAt: str(raw.ingestedAt),
		pointId: str(raw.pointId),
		// Additive health fields (contract section 4.4-F): kept only when the node sent them.
		...('max_chunk_id' in raw ? { max_chunk_id: count(raw.max_chunk_id) } : {}),
		...('deleted_chunks' in raw ? { deleted_chunks: count(raw.deleted_chunks) } : {}),
	};
}

/**
 * Read a `list_documents` success answer.
 *
 * @param value - The answer (already unwrapped).
 * @returns The page.
 */
export function readDocumentsPage(value: Record<string, unknown>): IDocumentsPageView {
	if (!Array.isArray(value.items)) {
		throw new ExplorerToolError({ kind: 'malformed', tool: 'list_documents', message: 'list_documents answered without a list: items must be a list of documents' });
	}
	const caveats = strings(value.caveats);
	return {
		items: value.items.map(readDocument).filter((item): item is IDocumentItem => item !== null),
		nextCursor: str(value.next_cursor),
		total: count(value.total),
		countsExact: value.counts_exact === true,
		distinct: value.distinct !== false,
		sorted: value.sorted === true,
		caveats,
		warnings: strings(value.warnings),
		pagingUnsupported: caveats.includes('documents_paging_unsupported'),
		...(value.filter_applied === 'server' || value.filter_applied === 'partial' || value.filter_applied === 'none' ? { filterApplied: value.filter_applied, filterIgnored: strings(value.filter_ignored) } : {}),
	};
}

// =============================================================================
// CHUNKS
// =============================================================================

/** A `chunks` page. */
export interface IChunksPageView {
	items: IChunkItem[];
	hasMore: boolean;
	nextAfter: number;
	total: number | null;
}

/**
 * Read a `chunks` success answer. Only the documented fields are kept, so a
 * vector a node might add never reaches the screen.
 *
 * @param value - The answer (already unwrapped).
 * @returns The page, in chunk order.
 */
export function readChunksPage(value: Record<string, unknown>): IChunksPageView {
	const items: IChunkItem[] = (Array.isArray(value.items) ? value.items : [])
		.filter(isPlainObject)
		.map((raw) => ({
			chunkId: count(raw.chunkId) ?? 0,
			content: typeof raw.content === 'string' ? raw.content : '',
			length: count(raw.length) ?? (typeof raw.content === 'string' ? raw.content.length : 0),
			isTable: raw.isTable === true,
			tableId: count(raw.tableId) ?? 0,
			isDeleted: raw.isDeleted === true,
			pointId: str(raw.pointId),
			metadata: isPlainObject(raw.metadata) ? Object.fromEntries(Object.entries(raw.metadata).filter(([key]) => key !== 'vector' && key !== 'embedding')) : {},
		}))
		.sort((a, b) => a.chunkId - b.chunkId);
	const last = items.length > 0 ? items[items.length - 1].chunkId : -1;
	return { items, hasMore: value.has_more === true, nextAfter: num(value.next_after) ?? last, total: count(value.total) };
}

// =============================================================================
// WRITES
// =============================================================================

/** A write's `audit` block, as far as the app shows it (it never carries content or vectors). */
export interface IWriteAudit {
	/** The tool's audit name ('vector.delete', 'vector.soft_delete', 'vector.restore'), or null. */
	action: string | null;
	/** Rows the write touched, or null where the store could not count them. */
	rows: number | null;
	/** Who called: the caller's `auth` ('account', 'agent', ...), or null. */
	caller: string | null;
}

/**
 * Read a write answer's `audit` block.
 *
 * @param value - The audit block, or anything.
 * @returns The audit, or null without one.
 */
export function readAudit(value: unknown): IWriteAudit | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const audit = value as Record<string, unknown>;
	const caller = audit.caller !== null && typeof audit.caller === 'object' ? str((audit.caller as Record<string, unknown>).auth) : null;
	return { action: str(audit.action), rows: count(audit.rows), caller };
}

/** A `delete` answer, per document. `delete` names no removed rows, so a document's own chunk count is unknown (null). */
export interface IRemoveView {
	removed: Array<{ objectId: string; chunks: number | null }>;
	notFound: string[];
	/** With `deleted_only`: documents left whole because a chunk of them is live. */
	keptLive: string[];
	/** Rows the node says it removed; null when it could not count them. */
	removedChunks: number | null;
	/** The answer's audit block, when it had one. */
	audit?: IWriteAudit | null;
}

/**
 * Read a `delete` success answer for the batch it answers.
 *
 * @param value - The answer (already unwrapped).
 * @param sent - The objectIds of the batch: those neither not found nor kept live were removed.
 * @returns What was removed, as the node reported it.
 */
export function readDeleteResult(value: Record<string, unknown>, sent: readonly string[]): IRemoveView {
	const notFound = strings(value.not_found);
	const keptLive = strings(value.kept_live);
	const left = new Set([...notFound, ...keptLive]);
	const removed = [...new Set(sent)].filter((objectId) => objectId !== '' && !left.has(objectId)).map((objectId) => ({ objectId, chunks: null }));
	return { removed, notFound, keptLive, removedChunks: count(value.removed_chunks), audit: readAudit(value.audit) };
}

/** A `soft_delete` or `restore` answer. */
export interface ITrashView {
	/** The documents asked for that are stored (distinct, in request order). */
	moved: string[];
	notFound: string[];
	/** The chunks the call moved; null when the store cannot count them. */
	matchedChunks: number | null;
	/** The answer's audit block, when it had one. */
	audit?: IWriteAudit | null;
}

/**
 * Read a `soft_delete` or `restore` success answer.
 *
 * @param value - The answer (already unwrapped).
 * @returns What it moved into or out of the trash.
 */
export function readTrashResult(value: Record<string, unknown>): ITrashView {
	const notFound = strings(value.not_found);
	const gone = new Set(notFound);
	return { moved: [...new Set(strings(value.object_ids))].filter((objectId) => !gone.has(objectId)), notFound, matchedChunks: count(value.matched_chunks), audit: readAudit(value.audit) };
}
