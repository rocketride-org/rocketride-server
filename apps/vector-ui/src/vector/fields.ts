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
// VECTOR - METADATA FIELDS (pure): what a collection's documents and chunks carry
// =============================================================================
//
// No store tool enumerates a collection's fields. So the fields are read
// from what the app already holds, and each row says how much it was read
// over:
//
//   - document fields come from the listing's rows (`list_documents`) and are
//     EXACT over the rows given (`coverage` of `of` rows have a value);
//   - chunk fields come from chunks read on purpose, a sample, so their
//     types are estimates and their coverage is "of N chunks read"
//     (`chunkFields`, filled in with the sampler).
//
// `searchFilter` says whether `search.filter` takes the field (objectId,
// nodeId, parent, isTable, the chunkId range); `listFilter` whether
// `list_documents.filter` has a condition on it.
// =============================================================================

import type { IChunkItem, IDocumentItem } from '../contract/types';
import { splitPath } from './documents';

/** A field's type, as read from its values. */
export type FieldType = 'text' | 'integer' | 'number' | 'boolean' | 'timestamp' | 'uuid' | 'json' | 'unknown';

/** One metadata field. */
export interface IFieldRow {
	name: string;
	type: FieldType;
	/** How many of the rows read have a value for it. */
	coverage: number;
	/** How many rows were read. */
	of: number;
	/** One value, as text (cut to a short line), or null when no row has one. */
	example: string | null;
	/** Whether `search.filter` takes it. */
	searchFilter: boolean;
	/** Whether `list_documents.filter` has a condition on it. */
	listFilter: boolean;
	/** Read from the listing's rows, or from chunks read on purpose. */
	source: 'listing' | 'chunks';
}

/** The fields read for a connection, kept in its entry (`entry.fields`). */
export interface IFieldsEstimate {
	rows: IFieldRow[];
	/** Chunks read for the chunk fields (0 before a sample). */
	chunksRead: number;
	/** Documents those chunks came from. */
	documentsRead: number;
	/** When it was read (ms since the epoch). */
	at: number;
}

/** The longest example shown. */
export const FIELD_EXAMPLE_MAX = 80;

/** The document fields the listing answers with, and what each filter takes. */
const DOCUMENT_FIELDS: ReadonlyArray<{ name: keyof IDocumentItem; type: FieldType; searchFilter: boolean; listFilter: boolean }> = [
	// path_prefix, path_contains and file_types.
	{ name: 'path', type: 'text', searchFilter: false, listFilter: true },
	{ name: 'size', type: 'integer', searchFilter: false, listFilter: false },
	{ name: 'modifyTime', type: 'timestamp', searchFilter: false, listFilter: false },
	// ingested_after and ingested_before.
	{ name: 'ingestedAt', type: 'timestamp', searchFilter: false, listFilter: true },
	{ name: 'nodeId', type: 'text', searchFilter: true, listFilter: false },
	// min_chunks and max_chunks.
	{ name: 'chunks', type: 'integer', searchFilter: false, listFilter: true },
	// has_tables.
	{ name: 'tables', type: 'integer', searchFilter: false, listFilter: true },
];

/**
 * A value as one short line of text.
 *
 * @param value - Any value.
 * @returns The text, cut to {@link FIELD_EXAMPLE_MAX} characters.
 */
function exampleText(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > FIELD_EXAMPLE_MAX ? `${text.slice(0, FIELD_EXAMPLE_MAX - 1)}…` : text;
}

/**
 * The document fields, exact over the rows given.
 *
 * @param rows - The listing's rows (the loaded ones).
 * @returns One row per field; none for no rows (nothing was read).
 */
export function documentFields(rows: readonly IDocumentItem[]): IFieldRow[] {
	if (rows.length === 0) return [];
	return DOCUMENT_FIELDS.map((field) => {
		let coverage = 0;
		let example: string | null = null;
		for (const row of rows) {
			const value = row[field.name];
			if (value === null || value === undefined || value === '') continue;
			coverage += 1;
			example ??= exampleText(value);
		}
		return { name: field.name, type: field.type, coverage, of: rows.length, example, searchFilter: field.searchFilter, listFilter: field.listFilter, source: 'listing' };
	});
}

/** The `search.filter` keys a chunk metadata key maps to (NF: objectId/objectIds, nodeId, parent as an exact path, isTable, the chunk range). */
const SEARCH_FILTER_KEYS: Readonly<Record<string, string>> = {
	objectId: 'objectId, objectIds',
	nodeId: 'nodeId',
	parent: 'parent (an exact path)',
	isTable: 'isTable',
	chunkId: 'minChunkId, maxChunkId',
};

/** The `list_documents.filter` keys a field has conditions on. */
const LIST_FILTER_KEYS: Readonly<Record<string, string>> = {
	path: 'path_prefix, path_contains, file_types',
	ingestedAt: 'ingested_after, ingested_before',
	chunks: 'min_chunks, max_chunks',
	tables: 'has_tables',
};

/**
 * What can filter on a field, in words that claim no more than the node does: a listing filter is applied by the
 * store only where it answers `filter_applied: server` (pgvector); elsewhere it is matched over the loaded rows.
 *
 * @param field - The field.
 * @returns The phrase.
 */
export function filterPhrase(field: Pick<IFieldRow, 'name' | 'searchFilter' | 'listFilter'>): string {
	const parts: string[] = [];
	if (field.searchFilter) parts.push(`Search filter: ${SEARCH_FILTER_KEYS[field.name] ?? field.name}`);
	if (field.listFilter) parts.push(`Listing filter: ${LIST_FILTER_KEYS[field.name] ?? field.name} (applied by the store on pgvector; elsewhere matched over loaded rows)`);
	return parts.length > 0 ? parts.join('; ') : 'Not filterable';
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The type of one value.
 *
 * @param value - A non-null value.
 * @returns Its type.
 */
function typeOfValue(value: unknown): FieldType {
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
	if (typeof value === 'string') return UUID.test(value) ? 'uuid' : ISO_TIME.test(value) ? 'timestamp' : 'text';
	if (typeof value === 'object') return 'json';
	return 'unknown';
}

/**
 * The type of a field from all its values: the same type for all, integer and number together are number, anything
 * else mixed is unknown.
 *
 * @param types - One type per value.
 * @returns The type.
 */
function mergeTypes(types: ReadonlySet<FieldType>): FieldType {
	if (types.size === 1) return [...types][0];
	if (types.size === 2 && types.has('integer') && types.has('number')) return 'number';
	return 'unknown';
}

/**
 * The chunk fields read from chunks: every key of their `metadata`, with its type guessed from the values, how many
 * of the chunks have a value, and one example. A key no chunk has a value for is not listed. The result is an
 * estimate over the chunks given, never over the collection.
 *
 * @param chunks - The chunks read.
 * @returns One row per key, in the order the keys were first seen.
 */
export function chunkFields(chunks: readonly IChunkItem[]): IFieldRow[] {
	const seen = new Map<string, { coverage: number; example: string | null; types: Set<FieldType> }>();
	for (const chunk of chunks) {
		for (const [name, value] of Object.entries(chunk.metadata ?? {})) {
			if (value === null || value === undefined || value === '') continue;
			let entry = seen.get(name);
			if (!entry) {
				entry = { coverage: 0, example: null, types: new Set() };
				seen.set(name, entry);
			}
			entry.coverage += 1;
			entry.example ??= exampleText(value);
			entry.types.add(typeOfValue(value));
		}
	}
	return [...seen].map(([name, entry]) => ({
		name,
		type: mergeTypes(entry.types),
		coverage: entry.coverage,
		of: chunks.length,
		example: entry.example,
		searchFilter: name in SEARCH_FILTER_KEYS,
		listFilter: false,
		source: 'chunks',
	}));
}

/**
 * The documents to read chunks from: up to `n` spread over the folders, one from each folder in turn (folders in name
 * order, documents in the order given), skipping the trashed and the empty.
 *
 * @param rows - The loaded documents.
 * @param n - How many to pick.
 * @returns The picked rows.
 */
export function sampleDocuments(rows: readonly IDocumentItem[], n = 5): IDocumentItem[] {
	const byFolder = new Map<string, IDocumentItem[]>();
	for (const row of rows) {
		if (row.deleted || row.chunks === 0) continue;
		const folder = splitPath(row.path).folder;
		const list = byFolder.get(folder);
		if (list) list.push(row);
		else byFolder.set(folder, [row]);
	}
	const lists = [...byFolder.keys()].sort().map((folder) => byFolder.get(folder) ?? []);
	const picked: IDocumentItem[] = [];
	for (let round = 0; picked.length < n; round += 1) {
		let any = false;
		for (const list of lists) {
			if (round < list.length) {
				any = true;
				picked.push(list[round]);
				if (picked.length >= n) break;
			}
		}
		if (!any) break;
	}
	return picked;
}

/**
 * The fields to show: the listing's rows first (exact), then the chunk fields that are not already a document field.
 *
 * @param listing - {@link documentFields}.
 * @param chunks - {@link chunkFields}.
 * @returns The merged rows.
 */
export function mergeFields(listing: readonly IFieldRow[], chunks: readonly IFieldRow[]): IFieldRow[] {
	const names = new Set(listing.map((f) => f.name));
	return [...listing, ...chunks.filter((f) => !names.has(f.name))];
}

/** How many field names the drawer lists. */
export const FIELDS_SUMMARY_NAMES = 8;

/**
 * One line about the fields read, for the connection drawer.
 *
 * @param estimate - The connection's fields, or null before any were read.
 * @returns The sentence.
 */
export function fieldsSummary(estimate: IFieldsEstimate | null): string {
	if (estimate === null || estimate.rows.length === 0) return 'Not read yet. No store lists a collection\'s fields, so the Collection tab reads them from a sample on request.';
	const names = estimate.rows.slice(0, FIELDS_SUMMARY_NAMES).map((f) => f.name).join(', ');
	const more = estimate.rows.length > FIELDS_SUMMARY_NAMES ? `, and ${estimate.rows.length - FIELDS_SUMMARY_NAMES} more` : '';
	const basis = estimate.chunksRead > 0 ? `chunk fields estimated from ${estimate.chunksRead} ${estimate.chunksRead === 1 ? 'chunk' : 'chunks'}` : 'document fields only';
	return `${names}${more} (${basis}).`;
}
