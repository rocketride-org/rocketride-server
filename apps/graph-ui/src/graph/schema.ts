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
// GRAPH - SCHEMA MODEL (what the schema sidebar shows, and what it may claim)
// =============================================================================
//
// The node reports its schema as the legacy `nodes`/`relationships` keys plus,
// on current nodes, a `schema` block (contract v1 section 1.4). What the sidebar
// may SAY depends on the evidence:
//
//   fresh      the last read succeeded; labels and types are what the snapshot holds
//   stale      the last refresh failed; the previous snapshot is shown with its age
//   error      the schema could not be read at all; nothing is claimed
//   incapable  the node cannot reflect; nothing is claimed
//   unknown    an old node (no `schema` block): the legacy lists are shown if they
//              have content, and an empty legacy answer is NOT an empty graph
//
// Property keys are SAMPLED, never exhaustive, and counts are catalogue
// estimates; the wording below never calls either exact.
// =============================================================================

import { isPlainObject } from './values';

// =============================================================================
// TYPES
// =============================================================================

/** Evidence the answer carries about itself. */
export type SchemaEvidence = 'fresh' | 'stale' | 'error' | 'incapable' | 'unknown';

/** A property with the types observed for it. */
export interface ISchemaProperty {
	name: string;
	types: string[];
}

/** A node label. */
export interface ISchemaLabel {
	name: string;
	properties: ISchemaProperty[];
	count: number | null;
	countEstimated: boolean;
}

/** One start/end label pair of a relationship type. */
export interface ISchemaEndpoint {
	start: string;
	end: string;
	/** True when the pair was seen in data; false when it was inferred. */
	observed: boolean;
}

/** A relationship type. */
export interface ISchemaRelationshipType {
	type: string;
	endpoints: ISchemaEndpoint[];
	properties: ISchemaProperty[];
	count: number | null;
	countEstimated: boolean;
}

/** A failure with its headline and the database's detail. */
export interface ISchemaError {
	headline: string;
	detail: string;
}

/** The schema as the sidebar uses it. */
export interface ISchemaView {
	evidence: SchemaEvidence;
	labels: ISchemaLabel[];
	relationshipTypes: ISchemaRelationshipType[];
	sampled: boolean;
	truncated: boolean;
	/** ISO-8601 time of the last successful refresh; null when there never was one. */
	refreshedAt: string | null;
	source: 'startup' | 'refresh' | 'legacy';
	error: ISchemaError | null;
	/** True when the lists came from an old node's legacy keys. */
	legacy: boolean;
}

/** The view for a call that failed outright. */
export const NO_SCHEMA: ISchemaView = { evidence: 'unknown', labels: [], relationshipTypes: [], sampled: false, truncated: false, refreshedAt: null, source: 'legacy', error: null, legacy: false };

// =============================================================================
// PARSING
// =============================================================================

/**
 * Split an error text into its headline (first line) and detail (the rest).
 *
 * @param text - An error text.
 * @returns The two parts.
 */
export function splitError(text: string): ISchemaError {
	const at = text.indexOf('\n');
	return at === -1 ? { headline: text.trim(), detail: '' } : { headline: text.slice(0, at).trim(), detail: text.slice(at + 1).trim() };
}

/**
 * Read a property list.
 *
 * @param value - The wire value.
 * @returns Properties with at least a name.
 */
function readProperties(value: unknown): ISchemaProperty[] {
	if (!Array.isArray(value)) return [];
	const out: ISchemaProperty[] = [];
	for (const item of value) {
		if (isPlainObject(item) && typeof item.name === 'string') out.push({ name: item.name, types: Array.isArray(item.types) ? item.types.filter((t): t is string => typeof t === 'string') : [] });
	}
	return out;
}

/**
 * Read an optional non-negative integer.
 *
 * @param value - The wire value.
 * @returns The integer, or null.
 */
function readCount(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * Turn a `get_schema` / `refresh_schema` answer into the sidebar's view.
 *
 * @param value - The tool's resolved value.
 * @returns The view; an old node's answer is `unknown` evidence, never an empty graph.
 */
export function parseSchema(value: unknown): ISchemaView {
	if (!isPlainObject(value)) return { ...NO_SCHEMA };
	const block = value.schema;
	if (!isPlainObject(block) || block.version !== 2) return parseLegacy(value);

	const labels: ISchemaLabel[] = [];
	for (const item of Array.isArray(block.labels) ? block.labels : []) {
		if (isPlainObject(item) && typeof item.name === 'string') labels.push({ name: item.name, properties: readProperties(item.properties), count: readCount(item.count), countEstimated: item.count_estimated === true });
	}
	const relationshipTypes: ISchemaRelationshipType[] = [];
	for (const item of Array.isArray(block.relationship_types) ? block.relationship_types : []) {
		if (!isPlainObject(item) || typeof item.type !== 'string') continue;
		const endpoints: ISchemaEndpoint[] = [];
		for (const e of Array.isArray(item.endpoints) ? item.endpoints : []) {
			if (isPlainObject(e) && typeof e.start === 'string' && typeof e.end === 'string') endpoints.push({ start: e.start, end: e.end, observed: e.observed !== false });
		}
		relationshipTypes.push({ type: item.type, endpoints, properties: readProperties(item.properties), count: readCount(item.count), countEstimated: item.count_estimated === true });
	}
	const error = typeof block.error === 'string' && block.error.length > 0 ? splitError(block.error) : null;
	const evidence: SchemaEvidence = block.capable === false ? 'incapable' : block.stale === true ? 'stale' : error !== null ? 'error' : 'fresh';
	return {
		evidence,
		labels,
		relationshipTypes,
		sampled: block.sampled === true,
		truncated: block.truncated === true,
		refreshedAt: typeof block.refreshed_at === 'string' ? block.refreshed_at : null,
		source: block.source === 'refresh' ? 'refresh' : 'startup',
		error,
		legacy: false,
	};
}

/**
 * Read an old node's legacy keys. The lists are shown when they have content;
 * an EMPTY legacy answer proves nothing (a failed read looks exactly like an
 * empty graph there), so the evidence stays `unknown` either way.
 *
 * @param value - The tool's resolved value.
 * @returns The legacy view.
 */
function parseLegacy(value: { [key: string]: unknown }): ISchemaView {
	const labelNames = new Set<string>();
	if (Array.isArray(value.labels)) for (const l of value.labels) if (typeof l === 'string') labelNames.add(l);
	const nodes = isPlainObject(value.nodes) ? value.nodes : {};
	for (const name of Object.keys(nodes)) labelNames.add(name);
	const labels: ISchemaLabel[] = [...labelNames].sort().map((name) => {
		const props = Array.isArray(nodes[name]) ? (nodes[name] as unknown[]) : [];
		const properties: ISchemaProperty[] = [];
		for (const p of props) if (isPlainObject(p) && typeof p.property === 'string') properties.push({ name: p.property, types: typeof p.type === 'string' ? [p.type.toLowerCase()] : [] });
		return { name, properties, count: null, countEstimated: false };
	});
	const byType = new Map<string, ISchemaRelationshipType>();
	for (const r of Array.isArray(value.relationships) ? value.relationships : []) {
		if (!isPlainObject(r) || typeof r.type !== 'string') continue;
		const entry = byType.get(r.type) ?? { type: r.type, endpoints: [], properties: [], count: null, countEstimated: false };
		if (typeof r.start === 'string' && typeof r.end === 'string') entry.endpoints.push({ start: r.start, end: r.end, observed: true });
		byType.set(r.type, entry);
	}
	const error = typeof value.error === 'string' && value.error.length > 0 ? splitError(value.error) : null;
	return { evidence: 'unknown', labels, relationshipTypes: [...byType.values()], sampled: true, truncated: false, refreshedAt: null, source: 'legacy', error, legacy: true };
}

// =============================================================================
// WORDING
// =============================================================================

/**
 * One line saying how far the schema can be trusted.
 *
 * @param view - The schema view.
 * @param now - The current time (ms since the epoch).
 * @returns Text for the sidebar header.
 */
export function schemaStatusText(view: ISchemaView, now: number): string {
	switch (view.evidence) {
		case 'incapable':
			return 'This node version cannot report its schema. Upgrade the node to browse labels and types.';
		case 'error':
			return view.refreshedAt === null ? 'The schema could not be read, so nothing is shown. Refresh to try again.' : `The last read failed. Showing nothing newer than ${ageText(view.refreshedAt, now)}.`;
		case 'stale':
			return `The last refresh failed; showing the snapshot from ${ageText(view.refreshedAt, now)}.`;
		case 'unknown':
			return view.legacy && (view.labels.length > 0 || view.relationshipTypes.length > 0) ? 'This node reports an older schema format, sampled when the pipeline started. It cannot be refreshed; upgrade the node for a refreshable schema.' : 'This node does not report enough to say what the graph holds. That is not the same as an empty graph.';
		default:
			return view.refreshedAt === null ? 'The schema has not been refreshed yet.' : `Schema ${ageText(view.refreshedAt, now)}.`;
	}
}

/**
 * Phrase a past time relative to now ("refreshed 3 minutes ago").
 *
 * @param iso - An ISO-8601 time, or null.
 * @param now - The current time.
 * @returns Text such as `refreshed 3 minutes ago`, or `never refreshed`.
 */
export function ageText(iso: string | null, now: number): string {
	if (iso === null) return 'never refreshed';
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 'refreshed at an unknown time';
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return 'refreshed just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `refreshed ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `refreshed ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	return `refreshed ${Math.round(hours / 24)} days ago`;
}

/** What the sampling flag means, for the sidebar's footnote. */
export const SAMPLED_NOTE = 'Property keys are sampled from a few nodes per label, so a property can exist that is not listed here.';

/**
 * Text for a count, never claiming exactness it does not have.
 *
 * @param count - A count, or null.
 * @param estimated - Whether it is a catalogue estimate.
 * @returns `about 1,200`, `1,200`, or ''.
 */
export function countText(count: number | null, estimated: boolean): string {
	if (count === null) return '';
	return `${estimated ? 'about ' : ''}${count.toLocaleString('en-US')}`;
}
