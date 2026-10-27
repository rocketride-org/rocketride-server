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

/**
 * The chunk fields read from chunks (their `metadata` keys). Not read yet: the sampler comes with the Collection tab.
 *
 * @param _chunks - The chunks read.
 * @returns The fields (none yet).
 */
export function chunkFields(_chunks: readonly IChunkItem[]): IFieldRow[] {
	return [];
}
