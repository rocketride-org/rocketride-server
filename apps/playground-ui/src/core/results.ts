// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Reading a pipeline's close body the way the Playground draws it. The
 * response node records each field it writes in `result_types` (key → lane
 * type) and every field is an array of items; these helpers turn that into
 * ordered lanes, tell a record-shaped answer from text, and give a media
 * item a source whether it came back as a file-store link or as base64.
 * Pure functions, no imports beyond types, so node:test drives them directly.
 */

import type { ResultBody } from './model';

// =============================================================================
// LANES
// =============================================================================

/** One field of a close body. */
export interface ResultLane {
	/** The field name as returned. */
	key: string;
	/** Its lane type (`answers`, `text`, `documents`, `image`, …). */
	type: string;
	/** Its items, in order. */
	items: unknown[];
}

/**
 * The close body's fields in `result_types` order, each as a list of items.
 * A field `result_types` names but the body lacks is left out; a body with
 * no `result_types` has no lanes.
 *
 * @param result - The close body.
 * @returns The lanes.
 */
export function lanesOf(result: ResultBody | undefined | null): ResultLane[] {
	const types = (result?.result_types ?? null) as Record<string, string> | null;
	if (!result || !types || typeof types !== 'object') return [];
	const lanes: ResultLane[] = [];
	for (const [key, type] of Object.entries(types)) {
		const value = result[key];
		if (value === undefined || value === null) continue;
		lanes.push({ key, type: String(type), items: Array.isArray(value) ? value : [value] });
	}
	return lanes;
}

// =============================================================================
// ANSWERS
// =============================================================================

/** An answer item as drawn: text, or a record of fields. */
export type AnswerItem = { kind: 'text'; text: string } | { kind: 'record'; record: Record<string, unknown> };

/**
 * Whether a value is a plain object (not an array, not null).
 *
 * @param value - Any value.
 * @returns True for a plain object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One `answers` item as text or a record. A string holding a JSON object is
 * a record; anything else that is not an object is text.
 *
 * @param item - The item as returned.
 * @returns The drawn form.
 */
export function readAnswer(item: unknown): AnswerItem {
	if (isRecord(item)) return { kind: 'record', record: item };
	if (typeof item === 'string') {
		const trimmed = item.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isRecord(parsed)) return { kind: 'record', record: parsed };
			} catch {
				// not JSON after all — it is text
			}
		}
		return { kind: 'text', text: item };
	}
	return { kind: 'text', text: item === undefined || item === null ? '' : JSON.stringify(item) };
}

/**
 * The record of a lane whose items are all records, else null — used to lay
 * several files' answers out as one table.
 *
 * @param items - A lane's items.
 * @returns The first record, or null when any item is text.
 */
export function firstRecord(items: unknown[]): Record<string, unknown> | null {
	let first: Record<string, unknown> | null = null;
	for (const item of items) {
		const read = readAnswer(item);
		if (read.kind !== 'record') return null;
		first ??= read.record;
	}
	return first;
}

/**
 * A field value as a short display string: scalars as they are, an array as
 * "N items", an object as JSON.
 *
 * @param value - The value as returned.
 * @returns The display string.
 */
export function cellText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

// =============================================================================
// MEDIA
// =============================================================================

/** A media item ready for an `<img>`, `<audio>` or `<video>`. */
export interface MediaSource {
	/** The element's `src`: a link as returned, or base64 as a `data:` URL; null when neither. */
	src: string | null;
	/** True when `src` is a link (it can expire), false for inline data. */
	isLink: boolean;
	/** The MIME type. */
	mime: string;
	/** The item's own name, when its metadata carries one. */
	name?: string;
}

/**
 * A media item's source. The response node returns either a file-store link
 * (an `http(s)` URL or a server path) or base64 in the lane's key; a `url`
 * or `link` field is read too. Either is drawn the same way.
 *
 * @param lane - The media lane (`image`, `audio`, `video`).
 * @param item - The item as returned.
 * @returns The source.
 */
export function mediaSource(lane: string, item: unknown): MediaSource {
	const rec = isRecord(item) ? item : {};
	const mime = typeof rec.mime_type === 'string' ? rec.mime_type : `${lane}/*`;
	const metadata = isRecord(rec.metadata) ? rec.metadata : {};
	const name = typeof metadata.name === 'string' ? metadata.name : undefined;

	// step: an explicit link field wins; then the lane's own value
	const linkField = [rec.url, rec.link].find((v): v is string => typeof v === 'string' && v.length > 0);
	const payload = linkField ?? (typeof rec[lane] === 'string' ? (rec[lane] as string) : null);
	if (!payload) return { src: null, isLink: false, mime, name };
	if (/^(https?:)?\/\//i.test(payload) || payload.startsWith('/')) return { src: payload, isLink: true, mime, name };
	return { src: `data:${mime};base64,${payload}`, isLink: false, mime, name };
}

// =============================================================================
// DOCUMENTS
// =============================================================================

/** A document passage as drawn. */
export interface DocumentPassage {
	/** The file it came from (the base name of `metadata.parent`). */
	file: string;
	/** Its text. */
	text: string;
	/** Its chunk number, when returned. */
	chunk?: number | string;
	/** Its score, when returned. */
	score?: number;
}

/**
 * A `documents` item as a passage.
 *
 * @param item - The item as returned (`Doc.toDict()`).
 * @returns The passage.
 */
export function readDocument(item: unknown): DocumentPassage {
	const rec = isRecord(item) ? item : {};
	const metadata = isRecord(rec.metadata) ? rec.metadata : {};
	const parent = typeof metadata.parent === 'string' ? metadata.parent : typeof metadata.objectName === 'string' ? metadata.objectName : '';
	const file = parent.split(/[\\/]/).pop() || parent || 'document';
	const chunk = typeof metadata.chunkId === 'number' || typeof metadata.chunkId === 'string' ? metadata.chunkId : undefined;
	return {
		file,
		text: typeof rec.page_content === 'string' ? rec.page_content : '',
		chunk,
		score: typeof rec.score === 'number' ? rec.score : undefined,
	};
}

// =============================================================================
// PLAIN TEXT
// =============================================================================

/**
 * A close body's answer as plain text, for a message's fallback `text` and
 * for the next question's history: the text lanes and text answers joined.
 *
 * @param result - The close body.
 * @returns The text ('' when the answer carries none).
 */
export function plainTextOf(result: ResultBody | undefined | null): string {
	const parts: string[] = [];
	for (const lane of lanesOf(result)) {
		if (lane.type !== 'answers' && lane.type !== 'text') continue;
		for (const item of lane.items) {
			const read = readAnswer(item);
			parts.push(read.kind === 'text' ? read.text : JSON.stringify(read.record));
		}
	}
	return parts.join('\n\n');
}
