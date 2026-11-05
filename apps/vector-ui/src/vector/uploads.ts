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
// VECTOR-UI — UPLOADS (planning a drop, batching it, and the upload rows)
// =============================================================================
//
// Pure rules behind the drop zone (the queue in src/ingest/ingestQueue.ts
// runs them):
//
//   PATHS   Each file is stored under the path it had in the drop, behind an
//           optional "Store under folder" prefix. A path is NFC-normalised,
//           loses control and bidi characters, uses '/' between folders, may
//           not start with '/' or contain '..', and no folder or file name may
//           exceed 255 UTF-8 bytes. The engine derives the document's objectId
//           from this path (objectId.ts); the app never sends one.
//   CAPS    20 files per drop, 50 MB per file, 200 MB per drop, allowlisted
//           extensions, no empty files, no path twice in one drop, no path
//           that is already being added. The parser's own size cap in the
//           templates backs the per-file limit on the engine side.
//   BATCHES Upload progress events are keyed by the file's BASE NAME only
//           (the SDK's sendFiles). Files whose base name is unique in the drop
//           are sent in one call, two at a time; files sharing a base name are
//           sent afterwards, one per call, so every event belongs to the one
//           file of that name in flight.
//   ROWS    queued → uploading → processing → counting → "N chunks added",
//           or failed with a sentence that does not pretend to know why.
//           Events (which other apps' files of the same name can produce)
//           only move a row through the sending states; the result sendFiles
//           returns for the file ends it.
//   DROPS   Each drop keeps its row ids and a copy of every row as it ended,
//           so its summary ("Drop of 12 files: 9 added (341 chunks) ·
//           2 replaced (19 chunks) · 1 not added · 00:48") counts exactly
//           what the rows said, live, and still after Clear finished drops
//           the rows. Chunk counts the store did not report are never added
//           up as if it had. Once the drop has finished, its new documents'
//           chunk keys go to the map, every document's first chunk before
//           any document's second, cut at the map's pin limit.
// =============================================================================

import type { ISendFile } from 'shared/explorer';
import type { IUploadEvent, IVectorCapabilities, VectorKey } from '../contract/types';
import { objectIdForPath } from './objectId';
import { utf8Bytes } from './sha1';

// =============================================================================
// Limits and types of file
// =============================================================================

/** Client-side upload caps. */
export interface UploadLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxDropBytes: number;
	maxSegmentBytes: number;
}

/** The caps every drop is checked against. */
export const UPLOAD_LIMITS: UploadLimits = { maxFiles: 20, maxFileBytes: 50 * 1024 * 1024, maxDropBytes: 200 * 1024 * 1024, maxSegmentBytes: 255 };

/** File types the console adds (the parser reads more; these are the ones the templates are tested with). */
export const ALLOWED_EXTENSIONS: readonly string[] = ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'rtf', 'txt', 'md', 'csv', 'html', 'json'];

/** MIME type sent with each allowlisted extension. */
const MIME_TYPES: Readonly<Record<string, string>> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	odt: 'application/vnd.oasis.opendocument.text',
	rtf: 'application/rtf',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	html: 'text/html',
	json: 'application/json',
};

/** The `accept` attribute of the file inputs. */
export const ACCEPT_ATTRIBUTE = ALLOWED_EXTENSIONS.map((extension) => `.${extension}`).join(',');

/** The hint under the drop zone's title. */
export const UPLOAD_HINT = `${ALLOWED_EXTENSIONS.map((extension) => extension.toUpperCase()).join(', ')} · up to ${UPLOAD_LIMITS.maxFiles} files · ${UPLOAD_LIMITS.maxFileBytes / (1024 * 1024)} MB each`;

/** `objinfo.origin` of every upload from the console. */
export const UPLOAD_ORIGIN = 'vector-explorer';

/** What a failed upload says: the engine's upload event does not carry the reason. */
export const FAILED_SENTENCE = "Failed. The engine did not return the reason; the pipeline's run log may. The document was not added.";

/** What a row says after its replacement was cancelled. */
export const CANCELLED_SENTENCE = 'Cancelled. Nothing was sent.';

/**
 * The lowercase extension of a file name.
 *
 * @param name - The name.
 * @returns The extension without the dot, or '' when there is none.
 */
export function extensionOf(name: string): string {
	const base = name.slice(name.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * The MIME type sent with a file.
 *
 * @param name - The file name.
 * @returns The type, or application/octet-stream.
 */
export function mimeTypeFor(name: string): string {
	return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

// =============================================================================
// Paths
// =============================================================================

/** A checked path, or why it was refused. */
export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Code point ranges removed from paths: C0 and C1 controls, DEL, and the bidi controls. */
const STRIPPED_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0000, 0x001f],
	[0x007f, 0x009f],
	[0x061c, 0x061c],
	[0x200e, 0x200f],
	[0x202a, 0x202e],
	[0x2066, 0x2069],
];

/**
 * Remove control and bidi characters.
 *
 * @param text - The text.
 * @returns The text without them.
 */
function stripInvisible(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (!STRIPPED_RANGES.some(([from, to]) => code >= from && code <= to)) out += ch;
	}
	return out;
}

/**
 * Normalise a path into its segments.
 *
 * @param raw - The path.
 * @param what - 'path' or 'folder', for the sentences.
 * @param limits - The caps.
 * @returns The segments, or why the path is refused.
 */
function segmentsOf(raw: string, what: 'path' | 'folder', limits: UploadLimits): { ok: true; segments: string[] } | { ok: false; reason: string } {
	const cleaned = stripInvisible(String(raw ?? '').normalize('NFC')).replace(/\\/g, '/');
	if (cleaned.startsWith('/')) {
		return { ok: false, reason: what === 'folder' ? "The folder may not start with '/'. Use a relative folder such as 'reports/2026'." : "Not added: the path may not start with '/'." };
	}
	const segments: string[] = [];
	for (const segment of cleaned.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			return { ok: false, reason: what === 'folder' ? "The folder may not contain '..'." : "Not added: the path may not contain '..'." };
		}
		if (utf8Bytes(segment).length > limits.maxSegmentBytes) {
			return { ok: false, reason: `Not added: a folder or file name in this path is longer than ${limits.maxSegmentBytes} bytes.` };
		}
		segments.push(segment);
	}
	return { ok: true, segments };
}

/**
 * Check the "Store under folder" box.
 *
 * @param raw - What was typed.
 * @param limits - The caps.
 * @returns The folder ('' for none), or why it is refused.
 */
export function normaliseFolderPrefix(raw: string, limits: UploadLimits = UPLOAD_LIMITS): PathCheck {
	const trimmed = String(raw ?? '').trim();
	if (trimmed === '') return { ok: true, path: '' };
	const checked = segmentsOf(trimmed, 'folder', limits);
	return checked.ok ? { ok: true, path: checked.segments.join('/') } : checked;
}

/**
 * The path a file is stored under.
 *
 * @param relPath - Its path in the drop.
 * @param prefix - The "Store under folder" value, if any.
 * @param limits - The caps.
 * @returns The path, or why it is refused.
 */
export function normaliseRelPath(relPath: string, prefix = '', limits: UploadLimits = UPLOAD_LIMITS): PathCheck {
	const folder = normaliseFolderPrefix(prefix, limits);
	if (!folder.ok) return folder;
	const checked = segmentsOf(relPath, 'path', limits);
	if (!checked.ok) return checked;
	if (checked.segments.length === 0) return { ok: false, reason: 'Not added: the file has no name.' };
	const path = checked.segments.join('/');
	return { ok: true, path: folder.path === '' ? path : `${folder.path}/${path}` };
}

// =============================================================================
// Planning a drop
// =============================================================================

/** One file of a drop (from dropTraversal). */
export interface DropCandidate {
	file: File;
	relPath: string;
}

/** A file that will be sent. */
export interface PlannedUpload {
	/** Row id ('u<n>'). */
	id: string;
	/** Position in the drop (rows keep the drop's order). */
	index: number;
	file: File;
	/** The file's base name: the key of its upload events. */
	name: string;
	/** The path it is stored under (sent as objinfo.name). */
	path: string;
	/** The objectId the engine will derive from the path (never sent). */
	objectId: string;
	size: number;
	mimetype: string;
}

/** A file that will not be sent, and why. */
export interface RefusedUpload {
	id: string;
	index: number;
	name: string;
	path: string;
	size: number;
	reason: string;
}

/** What a drop becomes. */
export interface DropPlan {
	accepted: PlannedUpload[];
	refused: RefusedUpload[];
}

/** Options of {@link planDrop}. */
export interface PlanOptions {
	/** The "Store under folder" value. */
	prefix?: string;
	/** Paths of earlier files that are still being added. */
	inFlightPaths?: ReadonlySet<string>;
	limits?: UploadLimits;
	/** Makes row ids unique across drops. */
	nextId?: () => string;
}

let planCounter = 0;

/**
 * A fresh row id.
 *
 * @returns 'u<n>'.
 */
function defaultId(): string {
	planCounter += 1;
	return `u${planCounter}`;
}

/**
 * Apply the path rules and caps to a drop.
 *
 * @param candidates - The dropped files with their paths.
 * @param options - Prefix, paths in flight, caps.
 * @returns What is sent and what is refused (with the sentence saying why).
 */
export function planDrop(candidates: readonly DropCandidate[], options: PlanOptions = {}): DropPlan {
	const limits = options.limits ?? UPLOAD_LIMITS;
	const nextId = options.nextId ?? defaultId;
	const accepted: PlannedUpload[] = [];
	const refused: RefusedUpload[] = [];
	const seen = new Set<string>();
	let total = 0;
	const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024)).toLocaleString('en-US')} MB`;

	candidates.forEach((candidate, index) => {
		const name = candidate.file.name;
		const size = typeof candidate.file.size === 'number' ? candidate.file.size : 0;
		const refuse = (path: string, reason: string): void => {
			refused.push({ id: nextId(), index, name, path, size, reason });
		};
		const checked = normaliseRelPath(candidate.relPath, options.prefix ?? '', limits);
		if (!checked.ok) {
			refuse(candidate.relPath, checked.reason);
			return;
		}
		const path = checked.path;
		const extension = extensionOf(path);
		if (!ALLOWED_EXTENSIONS.includes(extension)) {
			refuse(path, extension === '' ? 'Not added: files without a type (extension) are not supported.' : `Not added: .${extension} files are not supported.`);
			return;
		}
		if (size <= 0) {
			refuse(path, 'Not added: the file is empty.');
			return;
		}
		if (size > limits.maxFileBytes) {
			refuse(path, `Not added: larger than ${megabytes(limits.maxFileBytes)}.`);
			return;
		}
		if (seen.has(path)) {
			refuse(path, 'Not added: this drop already has a file at this path.');
			return;
		}
		if (options.inFlightPaths?.has(path)) {
			refuse(path, 'Not added: a file at this path is already being added.');
			return;
		}
		if (accepted.length >= limits.maxFiles) {
			refuse(path, `Not added: only ${limits.maxFiles} files can be added at a time. Drop the rest separately.`);
			return;
		}
		if (total + size > limits.maxDropBytes) {
			refuse(path, `Not added: a drop is limited to ${megabytes(limits.maxDropBytes)} in total. Drop the rest separately.`);
			return;
		}
		seen.add(path);
		total += size;
		accepted.push({ id: nextId(), index, file: candidate.file, name, path, objectId: objectIdForPath(path), size, mimetype: mimeTypeFor(path) });
	});
	return { accepted, refused };
}

// =============================================================================
// Batching and payloads
// =============================================================================

/** One sendFiles call. */
export interface SendUnit {
	files: PlannedUpload[];
	maxConcurrent: number;
}

/**
 * Group files into sendFiles calls so every progress event can be attributed:
 * unique base names together (two at a time), then each file whose base name
 * is shared on its own.
 *
 * @param files - The files to send, in drop order.
 * @returns The calls, in the order they are made.
 */
export function batchForSend(files: readonly PlannedUpload[]): SendUnit[] {
	const counts = new Map<string, number>();
	for (const file of files) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
	const unique = files.filter((file) => counts.get(file.name) === 1);
	const shared = files.filter((file) => (counts.get(file.name) ?? 0) > 1);
	const units: SendUnit[] = [];
	if (unique.length > 0) units.push({ files: unique, maxConcurrent: 2 });
	for (const file of shared) units.push({ files: [file], maxConcurrent: 1 });
	return units;
}

/**
 * The sendFiles payload of one call: the path as the object's name and the
 * console as its origin. No objectId: the engine derives it from the name.
 *
 * @param unit - The call.
 * @returns The files.
 */
export function sendFilesPayload(unit: SendUnit): ISendFile[] {
	return unit.files.map((file) => ({ file: file.file, objinfo: { name: file.path, origin: UPLOAD_ORIGIN }, mimetype: file.mimetype }));
}

// =============================================================================
// Rows
// =============================================================================

/** Where an upload is. */
export type UploadStatus = 'checking' | 'confirm' | 'queued' | 'uploading' | 'processing' | 'counting' | 'done' | 'failed' | 'refused' | 'cancelled';

/** One row of the upload list. */
export interface UploadRow {
	id: string;
	path: string;
	name: string;
	objectId: string;
	size: number;
	status: UploadStatus;
	bytesSent: number;
	fileSize: number;
	/** Chunks the store holds for the document after the upload (null when it did not say). */
	chunks: number | null;
	/** Chunks already stored under the path (the replace question). */
	existingChunks: number | null;
	/** The row's sentence when it is not a plain progress label. */
	message: string | null;
	/** What the engine or the store said, shown on request. */
	detail: string | null;
	/** True when the file was sent to replace a stored document (Replace was chosen); absent or false otherwise. */
	replaces?: boolean;
}

/** Statuses after which nothing changes a row. */
export const FINISHED: ReadonlySet<UploadStatus> = new Set<UploadStatus>(['done', 'failed', 'refused', 'cancelled']);

/** Progress order of the sending statuses (a row never moves back). */
const PROGRESS: Partial<Record<UploadStatus, number>> = { queued: 0, uploading: 1, processing: 2, counting: 3 };

/**
 * Apply one upload event to the row of the file in flight.
 *
 * Every app in the shell receives every upload event, and an event names its
 * file by base name only, so an event may belong to another app's file of the
 * same name. Events therefore only move a row through the sending states: an
 * event whose file size is not this file's is ignored, and an 'error' event
 * changes nothing (it may be another app's, and the SDK returns the same words
 * in the file's result). The result sendFiles returns for the file decides how
 * it ends, with its own error text ({@link applyFinalResult}).
 *
 * @param row - The row.
 * @param event - An `apaevt_status_upload` body.
 * @returns The new row (the same row when the event changes nothing).
 */
export function applyUploadEvent(row: UploadRow, event: IUploadEvent): UploadRow {
	if (FINISHED.has(row.status)) return row;
	if (typeof event.file_size === 'number' && event.file_size > 0 && row.size > 0 && event.file_size !== row.size) return row;
	const rank = PROGRESS[row.status] ?? 0;
	const fileSize = typeof event.file_size === 'number' && event.file_size > 0 ? event.file_size : row.fileSize;
	const bytesSent = typeof event.bytes_sent === 'number' ? Math.max(row.bytesSent, event.bytes_sent) : row.bytesSent;
	switch (event.action) {
		case 'open':
		case 'write':
			return rank > 1 ? row : { ...row, status: 'uploading', bytesSent, fileSize };
		case 'close':
			return rank > 2 ? row : { ...row, status: 'processing', bytesSent, fileSize };
		case 'complete':
			return { ...row, status: 'counting', bytesSent, fileSize };
		case 'error':
			// It may be another app's file of the same name: its words must not
			// show on this row. This file's own words arrive with its result.
			return row;
	}
	return row;
}

/**
 * The objectId the engine reports in a completed upload's pipeline result.
 *
 * @param result - The file's upload result.
 * @returns The id, or null when it reports none.
 */
function engineObjectId(result: Record<string, unknown>): string | null {
	const pipeline = result.result;
	if (pipeline === null || typeof pipeline !== 'object' || Array.isArray(pipeline)) return null;
	const id = (pipeline as Record<string, unknown>).objectId;
	return typeof id === 'string' && id !== '' && id.length <= 128 && !/\s/.test(id) ? id : null;
}

/**
 * Apply the result sendFiles returned for a file. This alone ends a sending
 * row: counting when the upload completed, failed (with the result's own
 * error text) otherwise, whatever the events said before. A completed
 * upload is counted under the objectId the engine reports for it; when that
 * is not the one the console derived, the row says so.
 *
 * @param row - The row.
 * @param result - The file's upload result.
 * @returns The new row.
 */
export function applyFinalResult(row: UploadRow, result: Record<string, unknown> | null | undefined): UploadRow {
	if (FINISHED.has(row.status)) return row;
	if (result && result.action === 'complete') {
		const bytes = typeof result.bytes_sent === 'number' ? result.bytes_sent : row.bytesSent;
		const reported = engineObjectId(result);
		const differs = reported !== null && reported !== row.objectId;
		return {
			...row,
			status: 'counting',
			bytesSent: Math.max(row.bytesSent, bytes),
			objectId: differs ? reported : row.objectId,
			message: null,
			detail: differs ? `The engine stored this file under objectId ${reported}; the console expected ${row.objectId}.` : null,
		};
	}
	const error = result && typeof result.error === 'string' && result.error !== '' ? result.error : null;
	return { ...row, status: 'failed', message: FAILED_SENTENCE, detail: error };
}

/**
 * "1 chunk" or "N chunks" (en-US grouping).
 *
 * @param chunks - The count.
 * @returns The words.
 */
function chunksWord(chunks: number): string {
	return chunks === 1 ? '1 chunk' : `${chunks.toLocaleString('en-US')} chunks`;
}

/**
 * The words a row shows.
 *
 * @param row - The row.
 * @returns Its label.
 */
export function uploadLabel(row: UploadRow): string {
	switch (row.status) {
		case 'checking':
			return 'Checking…';
		case 'confirm':
			return 'Waiting for your answer';
		case 'queued':
			return 'Queued';
		case 'uploading': {
			const percent = row.fileSize > 0 ? Math.min(100, Math.round((row.bytesSent / row.fileSize) * 100)) : 0;
			return `Uploading… ${percent}%`;
		}
		case 'processing':
			return 'Processing…';
		case 'counting':
			return 'Counting chunks…';
		case 'done':
			if (row.message !== null) return row.message;
			if (row.replaces === true) return row.chunks === null ? 'Replaced' : `Replaced: ${chunksWord(row.chunks)} stored`;
			if (row.chunks === null) return 'Added';
			return `${chunksWord(row.chunks)} added`;
		case 'failed':
		case 'refused':
		case 'cancelled':
			return row.message ?? 'Not added.';
	}
	return '';
}

// =============================================================================
// The collision probe and the replace question
// =============================================================================

/** An outcome of the `chunks` probe, as callTool folds it (src/chat/toolCalls.ts). */
export type ProbeCall = { ok: true; value: Record<string, unknown> } | { ok: false; code: string | null; message: string; kind: string | null; error: unknown };

/** What the probe says about a path. */
export type ProbeOutcome = { state: 'absent' } | { state: 'exists'; chunks: number | null } | { state: 'unknown'; reason: string };

/**
 * Read the `chunks({object_id, limit: 1})` probe: an answer means the path is
 * stored (with `total` chunks), NOT_FOUND means it is new, anything else
 * means the console could not tell.
 *
 * @param call - The probe's outcome.
 * @returns What it says.
 */
export function classifyProbe(call: ProbeCall): ProbeOutcome {
	if (call.ok) {
		const total = call.value.total;
		return { state: 'exists', chunks: typeof total === 'number' && Number.isFinite(total) ? total : null };
	}
	if (call.code === 'NOT_FOUND') return { state: 'absent' };
	return { state: 'unknown', reason: call.message };
}

/** One file the replace question is about. */
export type ConfirmItem = { rowId: string; path: string; state: 'exists'; chunks: number | null } | { rowId: string; path: string; state: 'unknown'; reason: string };

/** The replace question. */
export interface ReplaceQuestion {
	title: string;
	/** Paragraphs and list lines, in order. */
	message: string[];
	confirmLabel: string;
	cancelLabel: string;
}

/** Most paths listed in the question. */
const QUESTION_LIST_MAX = 20;

/**
 * "(N chunks)" after a path, or nothing when the count is unknown.
 *
 * @param chunks - The count.
 * @returns The suffix.
 */
function chunksSuffix(chunks: number | null): string {
	if (chunks === null) return '';
	return chunks === 1 ? ' (1 chunk)' : ` (${chunks.toLocaleString('en-US')} chunks)`;
}

/**
 * The question asked before files at stored (or uncheckable) paths are sent.
 *
 * @param items - The files concerned.
 * @returns Title, message lines and button labels (Cancel is focused by the dialog).
 */
export function replaceQuestion(items: readonly ConfirmItem[]): ReplaceQuestion {
	if (items.length === 1) {
		const only = items[0];
		if (only.state === 'exists') {
			return {
				title: 'Replace a stored document?',
				message: [`Replace existing '${only.path}'${chunksSuffix(only.chunks)}? The old chunks are removed when the new file is stored.`],
				confirmLabel: 'Replace document',
				cancelLabel: 'Cancel',
			};
		}
		return {
			title: 'Send this file?',
			message: [`Could not check whether '${only.path}' is already stored (${only.reason}). If it is, the new file replaces it.`],
			confirmLabel: 'Send anyway',
			cancelLabel: 'Cancel',
		};
	}
	const lines: string[] = [];
	const shown = items.slice(0, QUESTION_LIST_MAX);
	for (const item of shown) lines.push(item.state === 'exists' ? `${item.path}${chunksSuffix(item.chunks)}` : `${item.path}: could not check (${item.reason})`);
	if (items.length > shown.length) lines.push(`… and ${(items.length - shown.length).toLocaleString('en-US')} more`);
	return {
		title: `Replace ${items.length.toLocaleString('en-US')} documents?`,
		message: ['These paths are already stored, or could not be checked:', ...lines, 'The old chunks are removed when the new files are stored. Cancel sends none of these files; the others are added either way.'],
		confirmLabel: 'Replace documents',
		cancelLabel: 'Cancel',
	};
}

/**
 * The sentence a finished upload shows, from the store's chunk count.
 *
 * @param chunks - Chunks stored for the document (null when the store does not count).
 * @param replaced - Whether the file replaced a stored document.
 * @returns A sentence, or null for the plain "N chunks added" (or "Replaced: N chunks stored") label.
 */
export function chunkCountMessage(chunks: number | null, replaced = false): string | null {
	if (chunks === 0) return 'No chunks were stored: the file may have no text the parser can read.';
	if (chunks === null) return `${replaced ? 'Replaced' : 'Added'}. This store does not report chunk counts.`;
	return null;
}

// =============================================================================
// Drops: the summary above the rows, and where the new chunks landed
// =============================================================================

/** What "Show new chunks on the map" sent for a drop. */
export interface DropShown {
	/** Keys handed to the map (at most its pin limit). */
	placed: number;
	/** New chunks the drop stored (counted ones). */
	total: number;
}

/** One drop, as the queue keeps it for its summary. */
export interface IngestDrop {
	/** 'd<n>', unique within the connection's queue. */
	id: string;
	/** When the drop was handed to the queue (ms since the epoch). */
	startedAt: number;
	/** When its last file finished; null while any is in progress. */
	finishedAt: number | null;
	/** Its rows, in drop order. */
	rowIds: readonly string[];
	/** Each of its rows as it ended (the summary still counts a row Clear finished removed). */
	ended: Readonly<Record<string, UploadRow>>;
	/** What "Show new chunks on the map" sent, once it was used. */
	shown: DropShown | null;
}

/** A document of a drop that stored chunks the store counted. */
export interface DropDocument {
	/** The objectId the engine stored it under. */
	objectId: string;
	path: string;
	/** Chunks the store holds for it (> 0). */
	chunks: number;
}

/** What a drop became, counted from its rows. */
export interface DropSummary {
	id: string;
	/** Rows of the drop: every file it held, refused ones included. */
	files: number;
	/** Stored, and not as the replacement of a stored document. */
	added: number;
	/** Stored in place of a stored document (Replace was chosen). */
	replaced: number;
	/** Refused before sending, or failed. */
	notAdded: number;
	/** The replace question was answered Cancel. */
	cancelled: number;
	/** Waiting for the answer to the replace question. */
	waiting: number;
	/** Checking, queued, sending, processing or counting. */
	inProgress: number;
	/** Chunks of the added documents whose count the store reported. */
	chunksAdded: number;
	/** Chunks of the replacing documents whose count the store reported. */
	chunksReplaced: number;
	/** Added documents whose chunk count the store did not report. */
	uncountedAdded: number;
	/** Replacing documents whose chunk count the store did not report. */
	uncountedReplaced: number;
	/** uncountedAdded + uncountedReplaced. */
	uncounted: number;
	/** Documents with counted chunks, in drop order. */
	newDocuments: DropDocument[];
	/** Sum of their chunks. */
	newChunks: number;
	/** Every file of the drop has finished. */
	finished: boolean;
	/** From the drop to its last file's end (or to `now` while it runs). */
	elapsedMs: number;
	shown: DropShown | null;
}

/** The button under a finished drop that added chunks. */
export const SHOW_NEW_LABEL = 'Show new chunks on the map';

/** The store cannot draw a map (no `sample`). */
export const NO_MAP_SENTENCE = 'This store cannot draw a map, so new chunks cannot be shown on one.';

/** The store cannot place chunks outside the map's sample (no `project`). */
export const NO_PLACING_SENTENCE = "This store cannot place chunks outside the map's sample. Draw a new sample on the Map tab to see the new chunks.";

/** None of the drop's documents has a chunk count, so their chunk keys are unknown. */
export const UNCOUNTED_SENTENCE = 'The store did not report how many chunks these documents have, so they cannot be found on the map.';

/** Under a shown drop that replaced documents. */
export const REPLACED_PLACE_SENTENCE = 'Replaced documents the map already shows may keep their old place until the map draws a new sample.';

/**
 * Record the rows of running drops as they end, and end a drop with its last row.
 * Pure; a drop that does not change is returned as the same object.
 *
 * @param drops - The drops, oldest first.
 * @param rows - The current rows.
 * @param now - The time a drop that ends now ends at.
 * @returns The drops, and those that ended in this step.
 */
export function settleDrops(drops: readonly IngestDrop[], rows: readonly UploadRow[], now: number): { drops: IngestDrop[]; finished: IngestDrop[] } {
	const byId = new Map(rows.map((one) => [one.id, one]));
	const finished: IngestDrop[] = [];
	const next = drops.map((drop) => {
		if (drop.finishedAt !== null) return drop;
		let ended: Record<string, UploadRow> | null = null;
		for (const id of drop.rowIds) {
			if (drop.ended[id] !== undefined) continue;
			const one = byId.get(id);
			if (one === undefined || !FINISHED.has(one.status)) continue;
			ended = ended ?? { ...drop.ended };
			ended[id] = one;
		}
		const record = ended ?? drop.ended;
		const done = drop.rowIds.every((id) => record[id] !== undefined);
		if (ended === null && !done) return drop;
		const settled: IngestDrop = { ...drop, ended: record, finishedAt: done ? now : null };
		if (done) finished.push(settled);
		return settled;
	});
	return { drops: next, finished };
}

/**
 * Count a drop: ended rows from its record, the others from the live rows.
 *
 * @param drop - The drop.
 * @param rows - The current rows.
 * @param now - The clock, for a drop still running.
 * @returns The summary.
 */
export function summariseDrop(drop: IngestDrop, rows: readonly UploadRow[], now: number): DropSummary {
	const byId = new Map(rows.map((one) => [one.id, one]));
	const summary: DropSummary = {
		id: drop.id,
		files: drop.rowIds.length,
		added: 0,
		replaced: 0,
		notAdded: 0,
		cancelled: 0,
		waiting: 0,
		inProgress: 0,
		chunksAdded: 0,
		chunksReplaced: 0,
		uncountedAdded: 0,
		uncountedReplaced: 0,
		uncounted: 0,
		newDocuments: [],
		newChunks: 0,
		finished: drop.finishedAt !== null,
		elapsedMs: Math.max(0, (drop.finishedAt ?? now) - drop.startedAt),
		shown: drop.shown,
	};
	for (const id of drop.rowIds) {
		const one = drop.ended[id] ?? byId.get(id);
		if (one === undefined) continue;
		switch (one.status) {
			case 'done': {
				const counted = typeof one.chunks === 'number' && Number.isInteger(one.chunks) && one.chunks >= 0;
				if (one.replaces === true) {
					summary.replaced += 1;
					if (counted) summary.chunksReplaced += one.chunks as number;
					else summary.uncountedReplaced += 1;
				} else {
					summary.added += 1;
					if (counted) summary.chunksAdded += one.chunks as number;
					else summary.uncountedAdded += 1;
				}
				if (counted && (one.chunks as number) > 0) summary.newDocuments.push({ objectId: one.objectId, path: one.path, chunks: one.chunks as number });
				break;
			}
			case 'failed':
			case 'refused':
				summary.notAdded += 1;
				break;
			case 'cancelled':
				summary.cancelled += 1;
				break;
			case 'confirm':
				summary.waiting += 1;
				break;
			default:
				summary.inProgress += 1;
		}
	}
	summary.uncounted = summary.uncountedAdded + summary.uncountedReplaced;
	summary.newChunks = summary.newDocuments.reduce((sum, doc) => sum + doc.chunks, 0);
	return summary;
}

/**
 * Elapsed time as "mm:ss", or "h:mm:ss" from an hour.
 *
 * @param ms - Milliseconds.
 * @returns The clock text ("00:00" for nothing, a negative or a non-number).
 */
export function formatElapsed(ms: number): string {
	const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	const pad = (value: number): string => String(value).padStart(2, '0');
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * " (N chunks)", " (N chunks; K not counted)" or " (chunks not counted)" after a count of documents.
 *
 * @param documents - Documents in the segment.
 * @param chunks - Their counted chunks.
 * @param uncounted - Those without a count.
 * @returns The suffix.
 */
function chunkPart(documents: number, chunks: number, uncounted: number): string {
	if (uncounted === 0) return ` (${chunksWord(chunks)})`;
	if (uncounted >= documents) return ' (chunks not counted)';
	return ` (${chunksWord(chunks)}; ${uncounted.toLocaleString('en-US')} not counted)`;
}

/**
 * The summary line in pieces: the head ("Drop of 12 files:") and the
 * segments joined by " · " ("9 added (341 chunks)", …, "00:48"), so a
 * narrow panel can break the line between segments and never inside one.
 *
 * @param summary - The drop's counts.
 * @returns The head and the segments.
 */
export function dropSummaryParts(summary: DropSummary): { head: string; parts: string[] } {
	const n = (value: number): string => value.toLocaleString('en-US');
	const parts: string[] = [];
	if (summary.added > 0) parts.push(`${n(summary.added)} added${chunkPart(summary.added, summary.chunksAdded, summary.uncountedAdded)}`);
	if (summary.replaced > 0) parts.push(`${n(summary.replaced)} replaced${chunkPart(summary.replaced, summary.chunksReplaced, summary.uncountedReplaced)}`);
	if (summary.notAdded > 0) parts.push(`${n(summary.notAdded)} not added`);
	if (summary.cancelled > 0) parts.push(`${n(summary.cancelled)} cancelled`);
	if (summary.waiting > 0) parts.push(`${n(summary.waiting)} waiting for your answer`);
	if (summary.inProgress > 0) parts.push(`${n(summary.inProgress)} in progress`);
	parts.push(formatElapsed(summary.elapsedMs));
	return { head: `Drop of ${summary.files === 1 ? '1 file' : `${n(summary.files)} files`}:`, parts };
}

/**
 * The summary line: "Drop of 12 files: 9 added (341 chunks) · 2 replaced (19 chunks) · 1 not added · 00:48".
 *
 * @param summary - The drop's counts.
 * @returns The line.
 */
export function dropSummaryText(summary: DropSummary): string {
	const { head, parts } = dropSummaryParts(summary);
	return `${head} ${parts.join(' · ')}`;
}

/**
 * The chunk keys of a drop's new documents for the map: every document's
 * chunk 0, then every document's chunk 1, and so on, cut at `cap`, so a
 * capped list still places every document (up to `cap` documents).
 *
 * @param documents - The documents, in drop order.
 * @param cap - Most keys (the map's pin limit, limits.project_keys_max).
 * @returns The keys, and how many new chunks there are in all.
 */
export function newChunkKeys(documents: readonly DropDocument[], cap: number): { keys: VectorKey[]; total: number } {
	const total = documents.reduce((sum, doc) => sum + doc.chunks, 0);
	const limit = Math.max(0, Math.min(Math.floor(cap), total));
	const keys: VectorKey[] = [];
	for (let chunk = 0; keys.length < limit; chunk++) {
		for (const doc of documents) {
			if (keys.length >= limit) break;
			if (chunk < doc.chunks) keys.push([doc.objectId, chunk]);
		}
	}
	return { keys, total };
}

/**
 * "N of M new chunks placed" when the map's pin limit cut the list.
 *
 * @param placed - Keys sent.
 * @param total - New chunks in all.
 * @param cap - The pin limit.
 * @returns The sentence, or null when every new chunk was sent.
 */
export function placedSentence(placed: number, total: number, cap: number): string | null {
	if (placed >= total) return null;
	const n = (value: number): string => value.toLocaleString('en-US');
	return `${n(placed)} of ${n(total)} new chunks placed: the map pins at most ${n(cap)} chunks outside its sample.`;
}

/**
 * Why the map cannot show a drop's new chunks on this store.
 *
 * @param capabilities - dialect.capabilities.
 * @returns The sentence, or null when it can.
 */
export function showNewChunksReason(capabilities: IVectorCapabilities): string | null {
	if (capabilities.sample === false) return NO_MAP_SENTENCE;
	if (capabilities.project === false) return NO_PLACING_SENTENCE;
	return null;
}
