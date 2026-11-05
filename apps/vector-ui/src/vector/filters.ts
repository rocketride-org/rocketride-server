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
// VECTOR - SCOPE AND FILTERS (pure): conditions, the wire filter, matching, the scope's documents
// =============================================================================
//
// The ScopeBar's conditions (folder is under, file type is, ingested after or
// before, chunks between, has tables, missing first chunk) plus its path box.
// With at least one condition they make the console's SCOPE: the documents
// the directory lists and, when their toggles are on, the only documents the
// map samples, search searches and the chat asks about.
//
// THE STORE AND HERE. The listing asks the store for the conditions and the
// path box (as `path_contains`) in the wire shape of `documents.filter`
// (contract section 4.4-A, `listingFilter`); its answer says how much it
// applied (`filter_applied`: server, partial, none; an older node says
// nothing because it ignored the filter). Whatever the store did not apply is
// matched here over the loaded rows (`clientKeys`, `matches`), and the words
// always say which ("(store)", "(store; the path text filtered here)",
// "(filtered here; the store cannot filter by these)"). Until the store
// answers for a scope (its first page on its way, or failed) nothing is said
// about what it applies and nothing is counted: the scope is loading
// (`'pending'`). A count matched here over a listing that stopped short
// (capped, stalled) is only of the rows loaded, and the words say that too
// ("N of M loaded match", "at least"). The directory's "Documents in scope"
// export holds the scope's own loaded documents, whether or not the list is
// filtered by it (`directoryExportItems`).
// Without a condition the path box is not a scope and is never sent: it
// filters what is loaded, as it always did. A saved filter keeps the
// conditions only (`conditionsFilter`).
//
// THE SCOPE'S DOCUMENTS. `resolveScope` turns the listing into the objectIds
// the scope covers once the listing holds every document it lists; above
// `limits.scope_keys_max` (2,000) it gives the count instead (`overflow`), so
// no surface ever sends more than the cap. Until the ids are known (the
// listing pages, its first page failed, or it stopped short of every
// document) the map, search and chat are not scoped by it, and the Apply to
// toggles are off with the sentence that says why (`scopeReadiness`,
// `scopeAvailability`): a toggle never reads on while its surface is
// unscoped. Nothing here is kept outside memory.
// =============================================================================

import type { Availability, FilterApplied, IDocumentItem, IDocumentsFilter, IExportItem, IScopeState, IStatsResult } from '../contract/types';
import { DOCUMENTS_FILTER_KEYS } from '../contract/types';
import { DIRECTORY_LOAD_MORE } from './budgets';
import { documentExportRows, filterItems, filterSummary } from './documents';
import type { IPagerState } from './documents';
import type { IStatsView } from './results';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The path box and the conditions are applied this long after the last keystroke. */
export const FILTER_DEBOUNCE_MS = 150;

/** The node refuses a prefix or a substring longer than this (INVALID_INPUT). */
export const FILTER_TEXT_MAX = 1024;

/** One key of the wire filter. */
export type FilterKey = (typeof DOCUMENTS_FILTER_KEYS)[number];

// =============================================================================
// CONDITIONS
// =============================================================================

/** The kinds of condition, in the order the Add condition menu and the chips list them. */
export const CONDITION_KINDS = ['folder', 'fileType', 'ingestedAfter', 'ingestedBefore', 'chunks', 'hasTables', 'firstChunk'] as const;

/** One kind of condition. */
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/** One condition of the scope (at most one of each kind). */
export type ICondition = { kind: 'folder'; prefix: string } | { kind: 'fileType'; types: readonly string[] } | { kind: 'ingestedAfter'; at: string } | { kind: 'ingestedBefore'; at: string } | { kind: 'chunks'; min: number | null; max: number | null } | { kind: 'hasTables'; value: boolean } | { kind: 'firstChunk'; present: boolean };

/** The ScopeBar's state: its conditions and the path box's text. */
export interface IFilter {
	conditions: readonly ICondition[];
	text: string;
}

/** No condition, an empty path box. */
export const EMPTY_FILTER: IFilter = Object.freeze({ conditions: Object.freeze([]) as readonly ICondition[], text: '' });

/** What the Add condition menu calls each kind. */
export const CONDITION_TITLES: Readonly<Record<ConditionKind, string>> = {
	folder: 'Folder is under',
	fileType: 'File type is',
	ingestedAfter: 'Ingested after',
	ingestedBefore: 'Ingested before',
	chunks: 'Chunks between',
	hasTables: 'Has tables',
	firstChunk: 'Missing first chunk',
};

/** Rank of each kind, for a stable chip order. */
const KIND_RANK: Readonly<Record<ConditionKind, number>> = Object.fromEntries(CONDITION_KINDS.map((kind, i) => [kind, i])) as Record<ConditionKind, number>;

/**
 * Lower-case, de-duplicated extensions (no dot), in the order given.
 *
 * @param types - Extensions as typed or chosen.
 * @returns The clean list.
 */
function cleanTypes(types: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of types) {
		const t = raw.trim().toLowerCase();
		if (t !== '' && !out.includes(t)) out.push(t);
	}
	return out;
}

/**
 * Add a condition, replacing one of the same kind; the chips keep the menu's order.
 *
 * @param filter - The filter.
 * @param condition - The condition to set.
 * @returns The new filter.
 */
export function setCondition(filter: IFilter, condition: ICondition): IFilter {
	const clean: ICondition = condition.kind === 'fileType' ? { kind: 'fileType', types: cleanTypes(condition.types) } : condition;
	const conditions = [...filter.conditions.filter((c) => c.kind !== condition.kind), clean].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
	return { conditions, text: filter.text };
}

/**
 * Take one kind of condition out.
 *
 * @param filter - The filter.
 * @param kind - The kind.
 * @returns The new filter, or the same one when that kind was not set.
 */
export function removeCondition(filter: IFilter, kind: ConditionKind): IFilter {
	if (!filter.conditions.some((c) => c.kind === kind)) return filter;
	return { conditions: filter.conditions.filter((c) => c.kind !== kind), text: filter.text };
}

/**
 * A list in words: 'a', 'a or b', 'a, b or c'.
 *
 * @param items - The words.
 * @param last - The word before the last item.
 * @returns The phrase.
 */
function listWords(items: readonly string[], last: string): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`;
}

/** The date part of an ISO time. */
function day(iso: string): string {
	return iso.slice(0, 10);
}

/** A count with its noun. */
function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * What a condition keeps, in words (the chip's label).
 *
 * @param condition - The condition.
 * @returns e.g. 'folder is under C:/demo/handbooks/'.
 */
export function conditionLabel(condition: ICondition): string {
	switch (condition.kind) {
		case 'folder':
			return `folder is under ${condition.prefix}`;
		case 'fileType':
			return `type is ${listWords(condition.types, 'or')}`;
		case 'ingestedAfter':
			return `ingested on or after ${day(condition.at)}`;
		case 'ingestedBefore':
			return `ingested before ${day(condition.at)}`;
		case 'chunks':
			if (condition.min !== null && condition.max !== null) return `${condition.min.toLocaleString('en-US')} to ${plural(condition.max, 'chunk', 'chunks')}`;
			if (condition.min !== null) return `at least ${plural(condition.min, 'chunk', 'chunks')}`;
			return `at most ${plural(condition.max ?? 0, 'chunk', 'chunks')}`;
		case 'hasTables':
			return condition.value ? 'has tables' : 'has no tables';
		case 'firstChunk':
			return condition.present ? 'has its first chunk' : 'missing first chunk';
	}
}

/**
 * A date input's value as the UTC midnight the filter sends.
 *
 * @param value - 'YYYY-MM-DD'.
 * @returns 'YYYY-MM-DDT00:00:00Z', or null for anything else.
 */
export function dateToIso(value: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const iso = `${value}T00:00:00Z`;
	const at = new Date(iso);
	return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value ? iso : null;
}

// =============================================================================
// THE WIRE FILTER
// =============================================================================

/**
 * The conditions and the path box in the wire shape of `documents.filter`:
 * only the keys that are set; the path box (trimmed) as `path_contains`.
 *
 * @param filter - The ScopeBar's state.
 * @returns The wire filter ({} for nothing).
 */
export function toDocumentsFilter(filter: IFilter): IDocumentsFilter {
	const out: IDocumentsFilter = {};
	for (const c of filter.conditions) {
		switch (c.kind) {
			case 'folder':
				out.path_prefix = c.prefix;
				break;
			case 'fileType':
				out.file_types = cleanTypes(c.types);
				break;
			case 'ingestedAfter':
				out.ingested_after = c.at;
				break;
			case 'ingestedBefore':
				out.ingested_before = c.at;
				break;
			case 'chunks':
				if (c.min !== null) out.min_chunks = c.min;
				if (c.max !== null) out.max_chunks = c.max;
				break;
			case 'hasTables':
				out.has_tables = c.value;
				break;
			case 'firstChunk':
				out.has_first_chunk = c.present;
				break;
		}
	}
	const text = filter.text.trim();
	if (text !== '') out.path_contains = text;
	// Documentation order, so two equal filters serialise the same.
	const ordered: IDocumentsFilter = {};
	for (const key of DOCUMENTS_FILTER_KEYS) if (out[key] !== undefined) (ordered as Record<string, unknown>)[key] = out[key];
	return ordered;
}

/**
 * The keys a wire filter sets (null and absent keys are not filtered by), in documentation order.
 *
 * @param filter - The wire filter.
 * @returns The keys.
 */
export function filterKeys(filter: IDocumentsFilter | null | undefined): FilterKey[] {
	if (!filter) return [];
	return DOCUMENTS_FILTER_KEYS.filter((key) => filter[key] !== null && filter[key] !== undefined);
}

/**
 * A copy of some keys of a wire filter.
 *
 * @param filter - The wire filter.
 * @param keys - The keys to keep.
 * @returns The copy.
 */
function pick(filter: IDocumentsFilter, keys: readonly FilterKey[]): IDocumentsFilter {
	const out: IDocumentsFilter = {};
	for (const key of keys) (out as Record<string, unknown>)[key] = Array.isArray(filter[key]) ? [...(filter[key] as string[])] : filter[key];
	return out;
}

/**
 * The conditions of a wire filter without the path box: what a saved filter keeps.
 *
 * @param filter - The wire filter.
 * @returns The conditions, or null when there is none.
 */
export function conditionsFilter(filter: IDocumentsFilter | null | undefined): IDocumentsFilter | null {
	const keys = filterKeys(filter).filter((key) => key !== 'path_contains');
	if (!filter || keys.length === 0) return null;
	return pick(filter, keys);
}

/**
 * What the directory's listing asks the store for: the scope's conditions and
 * its path box, so a store that filters by path text counts the box too.
 * The path box alone is not a scope and asks for nothing (it filters the
 * loaded rows here, as it always did).
 *
 * @param filter - The scope's wire filter.
 * @returns The listing's filter, or null when no condition is set.
 */
export function listingFilter(filter: IDocumentsFilter | null | undefined): IDocumentsFilter | null {
	if (!filter || conditionsFilter(filter) === null) return null;
	return pick(filter, filterKeys(filter));
}

/**
 * The listing kept for a new filter when the store would list the same rows
 * for it: only the path box changed, and the store skipped the path text: it
 * filters nothing ('none', or an older node that ignored the filter), or it
 * named `path_contains` among the keys it skipped ('partial') and the box is
 * still set. The rows, cursor and status stay; only the filter is the new one.
 * Else null: the new filter lists again.
 *
 * @param dir - The listing.
 * @param next - The new filter, or null for every document.
 * @returns The kept listing, or null.
 */
export function keepListing(dir: IPagerState, next: IDocumentsFilter | null): IPagerState | null {
	if (next === null || dir.filter === null || dir.filterApplied === null) return null;
	if (!sameFilter(conditionsFilter(dir.filter), conditionsFilter(next))) return null;
	if (dir.filterApplied === 'none') return { ...dir, filter: next, filterIgnored: filterKeys(next) };
	if (dir.filterApplied === 'partial' && dir.filterIgnored.includes('path_contains') && filterKeys(next).includes('path_contains')) return { ...dir, filter: next };
	return null;
}

/**
 * Whether two wire filters mean the same (key order, empty keys and the order of file types do not matter).
 *
 * @param a - A filter, or null for none.
 * @param b - Another.
 * @returns True when they keep the same documents.
 */
export function sameFilter(a: IDocumentsFilter | null | undefined, b: IDocumentsFilter | null | undefined): boolean {
	const canon = (f: IDocumentsFilter | null | undefined): string =>
		JSON.stringify(
			filterKeys(f).map((key) => {
				const value = (f as IDocumentsFilter)[key];
				return [key, Array.isArray(value) ? [...value].sort() : value];
			})
		);
	return canon(a) === canon(b);
}

/** An extension the node accepts in `file_types` (vx_types `_FILE_TYPE`): 1 to 16 lower-case letters and digits, no dot. */
export const FILE_TYPE_RE = /^[a-z0-9]{1,16}$/;

/** The node refuses more entries of `file_types` than this (vx_types `DOC_LIST_FILTER_TYPES_MAX`). */
export const FILTER_TYPES_MAX = 32;

/**
 * Whether an extension can be sent in `file_types` as it is.
 *
 * @param ext - The extension, without the dot.
 * @returns True when the node accepts it.
 */
export function isFilterExtension(ext: string): boolean {
	return FILE_TYPE_RE.test(ext);
}

/**
 * An ISO-8601 time as the node reads it (vx_types `_INSTANT`): a date,
 * optionally a time ('T', 't' or a space; seconds and up to nine fraction
 * digits optional) and, with a time, 'Z' or an offset '+HH:MM'.
 */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?([Zz]|[+-]\d{2}:\d{2})?)?$/;

/** The first and last instants the node can turn into its UTC form (years 1 to 9999). */
const FIRST_INSTANT_MS = Date.parse('0001-01-01T00:00:00Z');
const LAST_INSTANT_MS = Date.parse('9999-12-31T23:59:59Z');

/** Days in a month of the proleptic Gregorian calendar. */
function daysIn(year: number, month: number): number {
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/**
 * Read an ISO-8601 time the way the node does (no offset is UTC; the fraction
 * is dropped), refusing what it refuses: a month 13, February 30, hour 24, an
 * offset of 24 hours, and a time whose UTC form falls outside years 1 to 9999.
 *
 * @param text - The time.
 * @returns Epoch ms, or null when the node would refuse it.
 */
export function instantMs(text: string): number | null {
	const m = INSTANT_RE.exec(text.trim());
	if (m === null) return null;
	const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59) return null;
	let offset = 0;
	const zone = m[7];
	if (zone !== undefined && zone !== 'Z' && zone !== 'z') {
		const hours = Number(zone.slice(1, 3));
		const minutes = Number(zone.slice(4, 6));
		if (hours > 23 || minutes > 59) return null;
		offset = (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60_000;
	}
	// setUTCFullYear, not Date.UTC, which reads the years 0 to 99 as 1900 to 1999.
	const at = new Date(0);
	at.setUTCFullYear(year, month - 1, day);
	at.setUTCHours(hour, minute, second, 0);
	const ms = at.getTime() - offset;
	return ms >= FIRST_INSTANT_MS && ms <= LAST_INSTANT_MS ? ms : null;
}

/**
 * Check a wire filter by the node's rules (contract section 4.4-A), so the app
 * never sends what the node refuses with INVALID_INPUT.
 *
 * @param value - Anything.
 * @returns null when valid, else a sentence naming what is wrong.
 */
export function validateFilter(value: unknown): string | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'A filter is an object of conditions.';
	const filter = value as Record<string, unknown>;
	for (const key of Object.keys(filter)) if (!(DOCUMENTS_FILTER_KEYS as readonly string[]).includes(key)) return `Unknown condition '${key}'.`;
	const isSet = (key: string): boolean => filter[key] !== null && filter[key] !== undefined;
	for (const key of ['path_prefix', 'path_contains']) {
		if (!isSet(key)) continue;
		if (typeof filter[key] !== 'string') return `'${key}' must be text.`;
		if ((filter[key] as string).length > FILTER_TEXT_MAX) return `'${key}' is longer than ${FILTER_TEXT_MAX.toLocaleString('en-US')} characters.`;
	}
	if (isSet('file_types')) {
		const types = filter.file_types;
		if (!Array.isArray(types) || types.length === 0) return "'file_types' must list at least one extension.";
		if (types.length > FILTER_TYPES_MAX) return `'file_types' lists at most ${FILTER_TYPES_MAX} extensions.`;
		for (const t of types) if (typeof t !== 'string' || !isFilterExtension(t.trim().toLowerCase())) return `'${String(t)}' is not a file extension (letters and digits, without the dot).`;
	}
	for (const key of ['ingested_after', 'ingested_before']) {
		if (!isSet(key)) continue;
		const text = filter[key];
		if (typeof text !== 'string' || instantMs(text) === null) return `'${key}' must be an ISO-8601 date or time.`;
	}
	for (const key of ['min_chunks', 'max_chunks']) {
		if (!isSet(key)) continue;
		const n = filter[key];
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return `'${key}' must be a whole number of chunks, 0 or more.`;
	}
	if (isSet('min_chunks') && isSet('max_chunks') && (filter.min_chunks as number) > (filter.max_chunks as number)) return 'The smallest chunk count must be at most the largest.';
	for (const key of ['has_first_chunk', 'has_tables']) if (isSet(key) && typeof filter[key] !== 'boolean') return `'${key}' must be true or false.`;
	return null;
}

/**
 * Read a wire filter back into conditions and the path box (no validation; see {@link parseFilter}).
 *
 * @param filter - A valid wire filter.
 * @returns The ScopeBar's state.
 */
export function fromDocumentsFilter(filter: IDocumentsFilter): IFilter {
	let out: IFilter = { conditions: [], text: filter.path_contains ?? '' };
	if (filter.path_prefix != null) out = setCondition(out, { kind: 'folder', prefix: filter.path_prefix });
	if (filter.file_types != null) out = setCondition(out, { kind: 'fileType', types: filter.file_types });
	if (filter.ingested_after != null) out = setCondition(out, { kind: 'ingestedAfter', at: filter.ingested_after });
	if (filter.ingested_before != null) out = setCondition(out, { kind: 'ingestedBefore', at: filter.ingested_before });
	if (filter.min_chunks != null || filter.max_chunks != null) out = setCondition(out, { kind: 'chunks', min: filter.min_chunks ?? null, max: filter.max_chunks ?? null });
	if (filter.has_tables != null) out = setCondition(out, { kind: 'hasTables', value: filter.has_tables });
	if (filter.has_first_chunk != null) out = setCondition(out, { kind: 'firstChunk', present: filter.has_first_chunk });
	return out;
}

/**
 * Parse a wire filter (a saved filter, a chart's click) into conditions, refusing what the node would refuse.
 *
 * @param value - Anything.
 * @returns `{ filter }`, or `{ error }` with the sentence.
 */
export function parseFilter(value: unknown): { filter: IFilter } | { error: string } {
	const error = validateFilter(value);
	if (error !== null) return { error };
	return { filter: fromDocumentsFilter(value as IDocumentsFilter) };
}

/**
 * The conditions of a wire filter in words.
 *
 * @param filter - The wire filter.
 * @returns e.g. "folder is under C:/demo/ · type is md · path contains 'fal'", or 'every document'.
 */
export function describeFilter(filter: IDocumentsFilter | null | undefined): string {
	if (!filter) return 'every document';
	const parsed = fromDocumentsFilter(filter);
	const words = parsed.conditions.map(conditionLabel);
	if (parsed.text.trim() !== '') words.push(`path contains '${parsed.text.trim()}'`);
	return words.length === 0 ? 'every document' : words.join(' · ');
}

// =============================================================================
// MATCHING
// =============================================================================

/**
 * Whether a document keeps one key of a filter. A value the store did not give
 * (no ingest time, no chunk or table count) never matches: it cannot be shown to.
 */
function keeps(item: IDocumentItem, filter: IDocumentsFilter, key: FilterKey): boolean {
	switch (key) {
		case 'path_prefix':
			return item.path.startsWith(filter.path_prefix as string);
		case 'file_types': {
			const path = item.path.toLowerCase();
			const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
			return (filter.file_types as string[]).some((t) => name.endsWith(`.${t.trim().toLowerCase()}`));
		}
		case 'ingested_after':
		case 'ingested_before': {
			if (item.ingestedAt === null) return false;
			const at = Date.parse(item.ingestedAt);
			// The bound is read as the node reads it, so the rows matched here agree with the store.
			const bound = instantMs(filter[key] as string);
			if (!Number.isFinite(at) || bound === null) return false;
			return key === 'ingested_after' ? at >= bound : at < bound;
		}
		case 'min_chunks':
			return item.chunks !== null && item.chunks >= (filter.min_chunks as number);
		case 'max_chunks':
			return item.chunks !== null && item.chunks <= (filter.max_chunks as number);
		case 'has_first_chunk':
			return item.has_first_chunk === filter.has_first_chunk;
		case 'has_tables':
			return item.tables !== null && item.tables > 0 === filter.has_tables;
		case 'path_contains':
			return item.path.toLowerCase().includes((filter.path_contains as string).toLowerCase());
	}
}

/**
 * Whether a document matches a filter (here, over a loaded row).
 *
 * @param item - The directory row.
 * @param filter - The wire filter.
 * @param keys - Only these keys (default: every key the filter sets).
 * @returns True when it keeps every key.
 */
export function matches(item: IDocumentItem, filter: IDocumentsFilter, keys?: readonly string[]): boolean {
	for (const key of keys ?? filterKeys(filter)) {
		if (filter[key as FilterKey] === null || filter[key as FilterKey] === undefined) continue;
		if (!keeps(item, filter, key as FilterKey)) return false;
	}
	return true;
}

/**
 * The keys of a scope's filter matched here: the ones the store did not apply
 * (all of them when it applied none, said nothing or was not asked).
 *
 * @param filter - The scope's wire filter.
 * @param applied - What the listing's answer said, or null when the listing did not ask for it.
 * @param ignored - The keys the store skipped.
 * @returns The keys, in documentation order.
 */
export function clientKeys(filter: IDocumentsFilter, applied: FilterApplied | null, ignored: readonly string[]): FilterKey[] {
	const keys = filterKeys(filter);
	if (applied === 'server') return [];
	if (applied === 'partial') return keys.filter((k) => ignored.includes(k));
	return keys;
}

/** The documents a scope covers. */
export interface IScopeMatch {
	/** Their objectIds (each once), or null when there are more than the cap. */
	ids: string[] | null;
	/** How many there are when more than the cap, else null. */
	overflow: number | null;
	count: number;
	/** Their chunks summed here, or null when a matching document has no count. */
	chunks: number | null;
}

/**
 * The documents of the loaded rows a filter keeps, capped.
 *
 * @param rows - The loaded rows.
 * @param filter - The wire filter.
 * @param cap - `limits.scope_keys_max`.
 * @param keys - Only these keys (default: all of them).
 * @returns The ids (null above the cap), the count and the summed chunks.
 */
export function scopeObjectIds(rows: readonly IDocumentItem[], filter: IDocumentsFilter, cap: number, keys?: readonly string[]): IScopeMatch {
	const seen = new Set<string>();
	const ids: string[] = [];
	let chunks: number | null = 0;
	for (const row of rows) {
		if (seen.has(row.objectId) || !matches(row, filter, keys)) continue;
		seen.add(row.objectId);
		ids.push(row.objectId);
		chunks = chunks === null || row.chunks === null ? null : chunks + row.chunks;
	}
	return ids.length > cap ? { ids: null, overflow: ids.length, count: ids.length, chunks } : { ids, overflow: null, count: ids.length, chunks };
}

// =============================================================================
// RESOLVING THE SCOPE FROM THE DIRECTORY
// =============================================================================

/** The listing statuses after which the loaded rows are what the scope covers. */
const SETTLED: ReadonlySet<IPagerState['status']> = new Set(['done', 'capped', 'unsupported', 'stalled', 'error']);

/** What the directory tells about a scope. */
export interface IScopeView {
	/** Documents matching here (or the store's total when it applied everything and said). */
	count: number;
	/** The matching loaded rows' chunks, summed here, or null. */
	chunks: number | null;
	/** The matching rows' ids (≤ cap), or null above the cap. */
	ids: string[] | null;
	/** The rows loaded. */
	loaded: number;
	/** The listing is the one this scope asks for (filtered by it while its Documents toggle is on, else unfiltered). */
	current: boolean;
	/** The listing is current and ended (complete, capped, stopped). */
	settled: boolean;
	/**
	 * How the store answered for this scope: 'here' when the listing did not ask it; 'pending' while the
	 * listing asked and the store has not answered yet (its first page is on its way, or failed).
	 */
	applied: FilterApplied | 'here' | 'pending';
	ignored: string[];
	/** The store's total for the listing, when it gave one. */
	total: number | null;
	/**
	 * The count is the scope's own: the store counted it, or it was matched over a
	 * listing that loaded every document. False while pages arrive and when the
	 * listing stopped short (capped, stalled, failed): then it is of the loaded rows.
	 */
	exact: boolean;
	/**
	 * The listing is current and holds every document it lists (it ended, or
	 * loaded the store's total): its matches are every document the scope keeps.
	 */
	complete: boolean;
}

/**
 * What the directory knows about a scope.
 *
 * @param scope - The scope (its conditions and whether it filters the list).
 * @param dir - The directory's listing.
 * @param cap - `limits.scope_keys_max`.
 * @returns The view.
 */
export function scopeView(scope: Pick<IScopeState, 'filter'> & { applyTo?: Pick<IScopeState['applyTo'], 'documents'> }, dir: IPagerState, cap: number): IScopeView {
	const wanted = listingFilter(scope.filter);
	const asked = dir.filter !== null && sameFilter(dir.filter, wanted);
	// While the list is filtered by the scope, the listing must be the one that asked for it; otherwise an unfiltered one.
	const current = (scope.applyTo?.documents ?? true) && wanted !== null ? asked : dir.filter === null;
	// Asked, and no page answered yet: nothing is known about what the store applies (never 'none').
	const applied: IScopeView['applied'] = asked ? (dir.filterApplied ?? 'pending') : 'here';
	const keys = clientKeys(scope.filter, asked ? dir.filterApplied : null, dir.filterIgnored);
	const match = scopeObjectIds(dir.rows, scope.filter, cap, keys);
	const storeCounts = applied === 'server' && keys.length === 0 && dir.total !== null;
	const count = storeCounts ? Math.max(dir.total as number, match.count) : match.count;
	const complete = listingComplete(dir);
	return { count, chunks: match.chunks, ids: count > cap ? null : match.ids, loaded: dir.rows.length, current, settled: current && SETTLED.has(dir.status), applied, ignored: asked ? dir.filterIgnored : [], total: dir.total, exact: storeCounts || complete, complete: current && complete };
}

/**
 * Whether a listing holds every document it lists: it ended, or it loaded the store's total.
 *
 * @param dir - The listing.
 * @returns True when nothing more is to come.
 */
function listingComplete(dir: IPagerState): boolean {
	return dir.status === 'done' || (dir.total !== null && dir.rows.length >= dir.total);
}

/**
 * Resolve a scope's documents from the directory: its objectIds once the
 * listing for it holds every document it lists (null while it loads, while
 * the list still shows another listing, and when the listing stopped short:
 * capped, stalled, one page only or failed, since the rows loaded are then
 * only part of the scope), or, above the cap, the count as soon as it is
 * known. Returns the same object when nothing changed.
 *
 * @param scope - The scope.
 * @param dir - The directory's listing (filtered by the scope when its Documents toggle is on).
 * @param cap - `limits.scope_keys_max`.
 * @returns The resolved scope.
 */
export function resolveScope(scope: IScopeState, dir: IPagerState, cap: number): IScopeState {
	const view = scopeView(scope, dir, cap);
	const overflow = view.current && view.count > cap ? view.count : null;
	// Only a listing of every document names the scope's documents: a failed first page or a listing that stopped
	// short leaves them unknown (scopeReadiness says which), so no empty or partial scope is claimed.
	const objectIds = overflow === null && view.settled && view.applied !== 'pending' && view.complete ? view.ids : null;
	const label = describeFilter(scope.filter);
	const sameIds = scope.objectIds === objectIds || (scope.objectIds !== null && objectIds !== null && scope.objectIds.length === objectIds.length && scope.objectIds.every((id, i) => id === objectIds[i]));
	if (sameIds && scope.overflow === overflow && scope.label === label) return scope;
	return { ...scope, label, objectIds, overflow };
}

// =============================================================================
// BUILDING A SCOPE
// =============================================================================

/** Every surface on: what a new scope applies to. */
export const ALL_TARGETS: IScopeState['applyTo'] = Object.freeze({ documents: true, map: true, search: true, chat: true });

/**
 * The ScopeBar's state behind a scope: its conditions, and the path box.
 *
 * @param scope - The scope, or null.
 * @param text - The path box's text.
 * @returns The filter.
 */
export function filterOf(scope: Pick<IScopeState, 'filter'> | null | undefined, text: string): IFilter {
	if (!scope) return { conditions: [], text };
	return { conditions: fromDocumentsFilter(scope.filter).conditions, text };
}

/**
 * The scope of a filter: null with no condition (the path box alone is not a
 * scope); the previous scope itself when nothing changed; else a new,
 * unresolved scope that keeps the previous one's toggles.
 *
 * @param filter - The conditions and the path box.
 * @param prev - The scope before, or null.
 * @returns The scope.
 */
export function scopeFromFilter(filter: IFilter, prev: IScopeState | null | undefined): IScopeState | null {
	if (filter.conditions.length === 0) return null;
	const wire = toDocumentsFilter(filter);
	if (prev && sameFilter(prev.filter, wire)) return prev;
	return { filter: wire, label: describeFilter(wire), objectIds: null, overflow: null, applyTo: { ...(prev?.applyTo ?? ALL_TARGETS) } };
}

/**
 * A scope with the path box's new text (the same scope when it did not
 * change, or when the node would refuse the text: the ScopeBar says so).
 *
 * @param scope - The scope.
 * @param text - The path box, after its debounce.
 * @returns The scope.
 */
export function withText(scope: IScopeState, text: string): IScopeState {
	const next = scopeFromFilter(filterOf(scope, text), scope) ?? scope;
	return checkScope(next) === null ? next : scope;
}

/**
 * Why the node would refuse a new scope's conditions (a chart's bar, "Scope
 * to this folder", the path box), so the console says it instead of sending it.
 *
 * @param scope - The new scope, or null for none.
 * @returns null when it can be sent, else the sentence.
 */
export function checkScope(scope: Pick<IScopeState, 'filter'> | null): string | null {
	return scope === null ? null : validateFilter(scope.filter);
}

/**
 * A scope with conditions set from a wire filter (a chart's bar, a saved
 * filter, "Scope to this folder"): those kinds replace the scope's own, the
 * others stay.
 *
 * @param scope - The scope, or null.
 * @param text - The path box.
 * @param conditions - The conditions to set, in the wire shape.
 * @returns The new scope.
 */
export function scopeWith(scope: IScopeState | null | undefined, text: string, conditions: IDocumentsFilter): IScopeState | null {
	let filter = filterOf(scope, text);
	for (const condition of fromDocumentsFilter(conditions).conditions) filter = setCondition(filter, condition);
	return scopeFromFilter(filter, scope ?? null);
}

/** What the directory shows: its rows and the status line under the ScopeBar. */
export interface IDirectoryView {
	/** The rows to list, in the listing's order. */
	rows: IDocumentItem[];
	/** The status line, or null with nothing to say. */
	summary: string | null;
	/** What the directory knows about the scope, or null without one. */
	scope: IScopeView | null;
	/**
	 * The loaded documents the scope keeps, whatever its Documents toggle (on, they are the rows listed);
	 * null without a scope, or while the store has not answered for it.
	 */
	scopeRows: IDocumentItem[] | null;
}

/** The status line while the store has not answered for a scope yet. */
export const SCOPE_LOADING_TEXT = 'Loading the documents in scope…';

/**
 * The directory's rows and status line. Without a scope the path box filters
 * what is loaded, as it always did. With one, the rows are the listing's
 * filtered here by the keys the store did not apply (the path box among them);
 * with its Documents toggle off the list shows every document and the line
 * says how many the scope keeps.
 *
 * @param dir - The listing.
 * @param scope - The scope, or null.
 * @param text - The path box (applied, after its debounce).
 * @param cap - `limits.scope_keys_max`.
 * @returns The view.
 */
export function directoryView(dir: IPagerState, scope: IScopeState | null, text: string, cap: number): IDirectoryView {
	if (scope === null) {
		const rows = filterItems(dir.rows, text);
		return { rows, summary: filterSummary(dir, text, rows.length), scope: null, scopeRows: null };
	}
	const view = scopeView(scope, dir, cap);
	const listed = scope.applyTo.documents ? null : filterItems(dir.rows, text);
	// The store has not answered for the scope: say it is loading (a failed first page: the footer says why, with Retry).
	if (view.applied === 'pending') return { rows: listed ?? [], summary: dir.status === 'loading' ? SCOPE_LOADING_TEXT : null, scope: view, scopeRows: null };
	const asked = view.applied !== 'here';
	const keys = clientKeys(scope.filter, asked ? dir.filterApplied : null, dir.filterIgnored);
	const scopeRows = keys.length === 0 ? [...dir.rows] : dir.rows.filter((row) => matches(row, scope.filter, keys));
	if (listed !== null) return { rows: listed, summary: `Not applied to this list. Scope: ${scopeStatusText(view)}`, scope: view, scopeRows };
	return { rows: scopeRows, summary: scopeStatusText(view), scope: view, scopeRows };
}

/**
 * The directory's export items: the loaded documents, and with a scope the
 * loaded documents it keeps (whatever its Documents toggle). The scope's
 * label says "Loaded documents in scope" while its listing has not loaded
 * every document, so the count never reads as the scope's whole size.
 *
 * @param dir - The listing.
 * @param view - The directory's view of it ({@link directoryView}).
 * @returns The items.
 */
export function directoryExportItems(dir: IPagerState, view: IDirectoryView): IExportItem[] {
	const items: IExportItem[] = [{ id: 'directory-loaded', label: `Loaded documents (${dir.rows.length.toLocaleString('en-US')})`, kind: 'documents', disabled: dir.rows.length === 0 ? 'Nothing loaded yet' : null, rows: () => documentExportRows(dir.rows) }];
	if (view.scope === null) return items;
	const rows = view.scopeRows;
	if (rows === null) {
		items.push({ id: 'directory-scope', label: 'Documents in scope', kind: 'documents', disabled: 'The documents in scope have not loaded yet', rows: () => documentExportRows([]) });
		return items;
	}
	// Every document the scope keeps is loaded: the listing asked for the scope (or for every document) and ended complete.
	const complete = (view.scope.current || dir.filter === null) && (dir.status === 'done' || (dir.total !== null && dir.rows.length >= dir.total));
	const label = `${complete ? 'Documents in scope' : 'Loaded documents in scope'} (${rows.length.toLocaleString('en-US')})`;
	const disabled = rows.length > 0 ? null : complete ? 'No document matches the scope' : 'No loaded document matches the scope';
	items.push({ id: 'directory-scope', label, kind: 'documents', disabled, rows: () => documentExportRows(rows) });
	return items;
}

// =============================================================================
// AVAILABILITY AND WORDS
// =============================================================================

/** Available. */
const ON: Availability = { enabled: true, reason: null };

/**
 * Whether a kind of condition can be offered on this store.
 *
 * @param kind - The kind.
 * @param ctx - The dialect's and the stats' caveats, and the loaded rows.
 * @returns Available, or disabled with the sentence.
 */
export function conditionAvailability(kind: ConditionKind, ctx: { caveats: readonly string[]; rows: readonly IDocumentItem[] }): Availability {
	if ((kind === 'ingestedAfter' || kind === 'ingestedBefore') && ctx.caveats.includes('extras_not_stored')) return { enabled: false, reason: 'This store does not keep ingest times' };
	if (kind === 'chunks' && ctx.rows.length > 0 && ctx.rows.every((r) => r.chunks === null)) return { enabled: false, reason: 'This store does not count chunks per document' };
	if (kind === 'hasTables' && ctx.rows.length > 0 && ctx.rows.every((r) => r.tables === null)) return { enabled: false, reason: 'This store does not count table chunks' };
	return ON;
}

/** The words for the keys the store skipped. */
const KEY_WORDS: Readonly<Record<string, string>> = {
	path_prefix: 'the folder',
	file_types: 'file types',
	ingested_after: 'ingest dates',
	ingested_before: 'ingest dates',
	min_chunks: 'chunk counts',
	max_chunks: 'chunk counts',
	has_first_chunk: 'the first chunk',
	has_tables: 'tables',
	path_contains: 'the path text',
};

/**
 * The directory's status line for a scope. A count that is not the scope's
 * own (matched here over a listing that stopped short, or one the store
 * applied without a total) is said to be of the rows loaded.
 *
 * @param view - What the directory knows ({@link scopeView}); `exact` defaults to true.
 * @returns e.g. '12 documents match (store)', '12 of 5,000 loaded match (store; ingest dates filtered here)'.
 */
export function scopeStatusText(view: Pick<IScopeView, 'applied' | 'ignored' | 'count' | 'loaded' | 'total' | 'settled'> & { exact?: boolean }): string {
	const docs = (n: number) => (view.exact === false ? `${n.toLocaleString('en-US')} of ${view.loaded.toLocaleString('en-US')} loaded match` : `${n.toLocaleString('en-US')} ${n === 1 ? 'document matches' : 'documents match'}`);
	switch (view.applied) {
		case 'server':
			return `${docs(view.count)} (store)`;
		case 'partial': {
			const words = [...new Set(view.ignored.map((k) => KEY_WORDS[k] ?? k))];
			return `${docs(view.count)} (store; ${listWords(words, 'and')} filtered here)`;
		}
		case 'none':
			return `${view.count.toLocaleString('en-US')} of ${view.loaded.toLocaleString('en-US')} loaded match (filtered here; the store cannot filter by these)`;
		case 'pending':
			return SCOPE_LOADING_TEXT;
		default:
			return `${view.count.toLocaleString('en-US')} of ${view.loaded.toLocaleString('en-US')} loaded match (filtered here)`;
	}
}

/**
 * The sentence for a scope above the cap.
 *
 * @param count - Documents in scope.
 * @param cap - `limits.scope_keys_max`.
 * @param atLeast - The count is of the loaded rows only (the listing has not loaded every document).
 * @returns The sentence.
 */
export function tooLargeText(count: number, cap: number, atLeast = false): string {
	return `Scope too large for the map, search and chat (${atLeast ? 'at least ' : ''}${count.toLocaleString('en-US')} documents; at most ${cap.toLocaleString('en-US')}). Narrow the folder.`;
}

/** Why the map, search and chat are not scoped by a scope that keeps nothing (said only once every document is loaded). */
export const NO_MATCH_SCOPE = 'No document matches these conditions, so the map, search and chat are not scoped.';

/** Why the map, search and chat are not scoped while the scope's listing is on its way. */
export const SCOPE_WAITING_TEXT = "Waiting for the scope's documents; the map, search and chat are not scoped yet.";

/** Why they are not scoped after the scope's first page failed. */
export const SCOPE_FAILED_TEXT = "The scope's documents did not load; Retry the directory. The map, search and chat are not scoped.";

/** How far a listing is, in words: '500 of 600 loaded', '500 loaded'. */
function loadedWords(loaded: number, total: number | null): string {
	return total !== null && total >= loaded ? `${loaded.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} loaded` : `${loaded.toLocaleString('en-US')} loaded`;
}

/**
 * Why the map, search and chat are not scoped yet while the scope's listing pages.
 *
 * @param loaded - Rows loaded so far.
 * @param total - The store's total for the listing, when it said.
 * @returns e.g. "Waiting for the scope's documents (500 of 600 loaded); ...".
 */
export function scopeWaitingText(loaded: number, total: number | null): string {
	return loaded === 0 ? SCOPE_WAITING_TEXT : `Waiting for the scope's documents (${loadedWords(loaded, total)}); the map, search and chat are not scoped yet.`;
}

/** The end of every sentence for a listing that stopped short. */
const NOT_ALL_KNOWN = "so the scope's documents are not all known: the map, search and chat are not scoped.";

/** How far Load more goes: one click when the rest fits, else the pace. */
function loadMoreWords(left: number | null): string {
	const pace = `(${DIRECTORY_LOAD_MORE.toLocaleString('en-US')} at a time)`;
	if (left === null) return `Load more to include them ${pace}.`;
	return left <= DIRECTORY_LOAD_MORE ? `Load more to include the other ${left.toLocaleString('en-US')}.` : `Load more to include the other ${left.toLocaleString('en-US')} ${pace}.`;
}

/**
 * Why the map, search and chat are not scoped by a listing that stopped short.
 * A capped listing says how far Load more goes (the documents left when the
 * store counted them, and how many a click lists), so on a large collection
 * the instruction is one the user can weigh.
 *
 * @param status - How it stopped (capped, unsupported, stalled, error).
 * @param loaded - Rows loaded.
 * @param total - The store's total for the listing, when it said.
 * @returns The sentence, with what would include the rest.
 */
export function scopePartialText(status: IPagerState['status'], loaded: number, total: number | null): string {
	const n = loaded.toLocaleString('en-US');
	switch (status) {
		case 'capped':
			return total !== null && total > loaded ? `Only ${n} of ${total.toLocaleString('en-US')} documents are loaded, ${NOT_ALL_KNOWN} ${loadMoreWords(total - loaded)}` : `Only ${n} documents are loaded and more may exist, ${NOT_ALL_KNOWN} ${loadMoreWords(null)}`;
		case 'unsupported':
			return `Only the first page of documents is listed (${n} loaded), ${NOT_ALL_KNOWN}`;
		case 'stalled':
			return `Loading stopped at ${n} documents, ${NOT_ALL_KNOWN}`;
		case 'error':
			return `Loading stopped at ${n} documents, ${NOT_ALL_KNOWN} Retry the directory to include them.`;
		default:
			return `Only ${n} documents are loaded, ${NOT_ALL_KNOWN}`;
	}
}

/**
 * Where a scope's documents are:
 *   ready     its objectIds are known (at least one): the map, search and chat can be scoped;
 *   overflow  more than the cap;
 *   empty     every document is loaded and none matches;
 *   waiting   its listing is on its way (or the list still shows another one);
 *   failed    its first page failed (Retry);
 *   partial   its listing stopped short of every document (capped, one page only, stalled, failed part-way).
 */
export type ScopePhase = 'ready' | 'overflow' | 'empty' | 'waiting' | 'failed' | 'partial';

/** A scope's phase and why the map, search and chat are not scoped by it (null when ready). */
export interface IScopeReadiness {
	phase: ScopePhase;
	reason: string | null;
}

/**
 * Where a scope's documents are, resolved from the directory's listing when
 * given (else from the scope as it was last resolved: its objectIds not known
 * yet is 'waiting').
 *
 * @param scope - The scope.
 * @param cap - `limits.scope_keys_max`.
 * @param dir - The directory's listing, when known.
 * @returns The phase and the sentence.
 */
export function scopeReadiness(scope: IScopeState, cap: number, dir?: IPagerState | null): IScopeReadiness {
	const resolved = dir ? resolveScope(scope, dir, cap) : scope;
	const view = dir ? scopeView(resolved, dir, cap) : null;
	if (resolved.overflow !== null) return { phase: 'overflow', reason: tooLargeText(resolved.overflow, cap, view !== null && !view.exact) };
	if (resolved.objectIds !== null) return resolved.objectIds.length === 0 ? { phase: 'empty', reason: NO_MATCH_SCOPE } : { phase: 'ready', reason: null };
	if (!dir || view === null || !view.current) return { phase: 'waiting', reason: SCOPE_WAITING_TEXT };
	if (!view.settled) return { phase: 'waiting', reason: scopeWaitingText(view.loaded, dir.total) };
	if (view.applied === 'pending') return { phase: 'failed', reason: SCOPE_FAILED_TEXT };
	return { phase: 'partial', reason: scopePartialText(dir.status, view.loaded, dir.total) };
}

/**
 * Whether each surface can be scoped (the Apply to toggles): Map, Search and
 * Chat only once the scope's documents are known and fit the cap; otherwise
 * they are off, disabled with the sentence, never shown on while unscoped.
 *
 * @param scope - The scope.
 * @param cap - `limits.scope_keys_max`.
 * @param dir - The directory's listing, when known (the sentence then says how far it is).
 * @returns Per surface: available, or disabled with the sentence.
 */
export function scopeAvailability(scope: IScopeState, cap: number, dir?: IPagerState | null): Record<keyof IScopeState['applyTo'], Availability> {
	const readiness = scopeReadiness(scope, cap, dir);
	const others: Availability = readiness.phase === 'ready' ? ON : { enabled: false, reason: readiness.reason };
	return { documents: ON, map: others, search: others, chat: others };
}

/**
 * The directory's empty text when no listed row matches the scope: of the
 * loaded rows only while the listing has not loaded every document.
 *
 * @param view - What the directory knows about the scope.
 * @returns e.g. 'No loaded document matches these conditions (5,000 of 12,000 loaded).'
 */
export function scopeNoMatchText(view: Pick<IScopeView, 'complete' | 'loaded' | 'total'>): string {
	return view.complete ? 'No documents match these conditions.' : `No loaded document matches these conditions (${loadedWords(view.loaded, view.total)}).`;
}

/**
 * The stats strip's line while a scope is active. A count that is not the
 * scope's own (`exact` false: matched over the rows loaded so far) is "at
 * least", in the rows loaded.
 *
 * Before the store answered for the scope (`applied` 'pending') nothing is
 * counted: "Scope: loading…", or after a failed first page "not counted".
 *
 * @param view - The scope's count, its chunks (summed here), whether the listing settled, how many rows are loaded, whether the count is the scope's own (default true) and how the store answered.
 * @param stats - The last stats answer (its document count), or null.
 * @returns e.g. 'Scope: 12 of 42 documents · 318 chunks (counted here)'.
 */
export function scopeStripText(view: Pick<IScopeView, 'count' | 'chunks' | 'settled' | 'loaded'> & { exact?: boolean; applied?: IScopeView['applied'] }, stats: Pick<IStatsView, 'documents'> | Pick<IStatsResult, 'documents'> | null): string {
	if (view.applied === 'pending') return view.settled ? 'Scope: not counted (the listing did not load)' : 'Scope: loading…';
	const of = stats?.documents ?? null;
	const exact = view.exact !== false;
	const docs = `${exact ? '' : 'at least '}${of === null ? plural(view.count, 'document', 'documents') : `${view.count.toLocaleString('en-US')} of ${plural(of, 'document', 'documents')}`}`;
	const inLoaded = ` in the ${view.loaded.toLocaleString('en-US')} loaded`;
	if (view.chunks === null) return `Scope: ${docs}${exact ? '' : inLoaded}`;
	const partial = !exact || view.loaded < view.count;
	return `Scope: ${docs} · ${plural(view.chunks, 'chunk', 'chunks')}${partial ? inLoaded : ''} (counted here)`;
}
