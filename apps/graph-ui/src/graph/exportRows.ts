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
// GRAPH - EXPORT (a result as CSV or JSON, downloaded or copied)
// =============================================================================
//
// The results card's Export menu, for Table and Raw. It is built from the result
// itself (`columns` and `rows` exactly as the node returned them), never from the
// row objects the grid renders: the grid writes its own keys into those (Tabulator
// 6.5.2, SQL Explorer's fact 4). The rows it exports are the ones returned under
// the limit that was applied; the note says so when the limit cut the result short.
//
// JSON is an array of objects keyed by the Cypher column names (a repeated name
// gets ` (2)`, ` (3)`, so both values survive), with graph values in their wire
// form, so nothing is rounded or lost.
//
// CSV follows RFC 4180: CRLF between records, and a field holding a comma, a quote
// or a line break is quoted with its quotes doubled. NULL is an empty field and an
// empty string is `""`, so the two stay apart. Lists, maps and graph values are
// written as JSON text; a tagged scalar (a big integer, a date, a point) as its
// text. A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a
// formula, so in CSV only, text that starts with one of those, or with a tab or a
// carriage return, gets a leading `'`. Numbers (a tagged big integer is one) keep
// their sign, and JSON keeps the text as it is.
//
// A VS Code webview refuses downloads, so there CSV and JSON are copied instead.
// Ported from SQL Explorer's export (sql-ui/src/sql/export.ts).
// =============================================================================

import type { ReadQueryResult } from './types';
import { isGraphNumber, isTagged, valueText } from './values';

/** The CSV guard, in the export menu's words. */
export const CSV_FORMULA_NOTE = "CSV: text that starts with = + - or @ gets a leading ' so spreadsheets do not run it.";

/** Text a spreadsheet would read as a formula (or as the start of one). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** How long a download's object URL is kept before it is released. */
const DOWNLOAD_URL_LIFETIME_MS = 1000;

/** The formats the Export menu offers. */
export type ExportFormat = 'csv' | 'json';

/** One export, ready to deliver. */
export interface IExportPayload {
	/** The file's text. */
	text: string;
	/** Its media type. */
	mime: string;
	/** Its file extension, without the dot. */
	extension: string;
}

/** The part of a result an export reads. */
export type ExportSource = Pick<ReadQueryResult, 'columns' | 'rows'>;

/**
 * How a delivery ended. `downloaded` means the browser was handed the file: a page that blocks downloads without saying
 * so cannot be detected.
 */
export type ExportDelivery = 'downloaded' | 'copied' | 'failed' | 'too-large';

/** The most characters put on the clipboard when an export cannot be downloaded (a huge string can freeze the page or be refused). */
export const MAX_COPY_CHARS = 5_000_000;

/** What delivering needs from the page (injected, so the rule is testable). */
export interface IExportDeliveryDeps {
	/** True where downloads are refused (a VS Code webview). */
	downloadsRefused: boolean;
	/** Save the text as a file. Throws when the page refuses. */
	download(text: string, mime: string, fileName: string): void;
	/** Put the text on the clipboard. Rejects when refused. */
	copy(text: string): Promise<void>;
}

// =============================================================================
// COLUMNS
// =============================================================================

/**
 * The names an export gives the columns: the Cypher names, an empty one named by its position, and a repeat numbered
 * (`name`, `name (2)`), never one that collides with a real name.
 *
 * @param columns - The result's column names, in order.
 * @returns One distinct name per position.
 */
export function exportColumns(columns: readonly string[]): string[] {
	const taken = new Set<string>();
	const real = new Set(columns.filter((name) => name !== ''));
	return columns.map((raw, i) => {
		const base = raw === '' ? `(column ${i + 1})` : raw;
		let name = base;
		for (let n = 2; taken.has(name) || (name !== base && real.has(name)); n++) name = `${base} (${n})`;
		taken.add(name);
		return name;
	});
}

// =============================================================================
// FORMATS
// =============================================================================

/**
 * One CSV field.
 *
 * @param value - The raw cell value.
 * @returns The field.
 */
function csvField(value: unknown): string {
	if (value === null || value === undefined) return '';
	const raw = valueText(value);
	if (raw === '') return '""';
	const isText = typeof value === 'string' || (isTagged(value) && !isGraphNumber(value));
	const text = isText && FORMULA_START.test(raw) ? `'${raw}` : raw;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A result as RFC 4180 CSV, header first, with the formula guard.
 *
 * @param result - The result (its columns and rows are read, not changed).
 * @returns The CSV text.
 */
export function toCsv(result: ExportSource): string {
	const names = exportColumns(result.columns);
	const lines = [names.map((name) => csvField(name)).join(',')];
	for (const row of result.rows) lines.push(names.map((_, i) => csvField(row[i])).join(','));
	return lines.join('\r\n');
}

/**
 * A result as a JSON array of objects keyed by column name, a missing value as null.
 *
 * @param result - The result (its columns and rows are read, not changed).
 * @returns The JSON text.
 */
export function toJson(result: ExportSource): string {
	const names = exportColumns(result.columns);
	const records = result.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i] ?? null])));
	return JSON.stringify(records, null, 2);
}

/**
 * A result in one format.
 *
 * @param format - The format.
 * @param result - The result.
 * @returns The payload.
 */
export function exportResult(format: ExportFormat, result: ExportSource): IExportPayload {
	return format === 'csv' ? { text: toCsv(result), mime: 'text/csv;charset=utf-8', extension: 'csv' } : { text: toJson(result), mime: 'application/json', extension: 'json' };
}

/**
 * The file name for an export, e.g. `graph-results-20261004-153005.csv` (UTC).
 *
 * @param at - When it was made (ms since the epoch).
 * @param format - The format.
 * @returns The file name.
 */
export function exportFileName(at: number, format: ExportFormat): string {
	const d = new Date(at);
	const two = (n: number): string => String(n).padStart(2, '0');
	return `graph-results-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}.${format}`;
}

/**
 * What an export holds, in words: the rows returned, the limit applied, and whether the limit cut the result short.
 *
 * @param result - The result.
 * @returns A sentence for the export menu.
 */
export function exportNote(result: Pick<ReadQueryResult, 'rows' | 'row_limit' | 'truncated'>): string {
	const rows = result.rows.length;
	const base = `The ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'} returned (limit ${result.row_limit.toLocaleString('en-US')})`;
	return result.truncated ? `${base}, not the whole result: the limit was reached.` : `${base}.`;
}

// =============================================================================
// DELIVERY
// =============================================================================

/**
 * Deliver an export: it downloads, unless downloads are refused or the attempt throws, and then the text is copied (up to
 * {@link MAX_COPY_CHARS}; a larger one is not copied, and the answer says so).
 *
 * @param payload - The export and its file name.
 * @param deps - The page's download and clipboard.
 * @returns How it ended.
 */
export async function deliverExport(payload: IExportPayload & { fileName: string }, deps: IExportDeliveryDeps): Promise<ExportDelivery> {
	if (!deps.downloadsRefused) {
		try {
			deps.download(payload.text, payload.mime, payload.fileName);
			return 'downloaded';
		} catch {
			// Refused by the page: the clipboard is the fallback.
		}
	}
	if (payload.text.length > MAX_COPY_CHARS) return 'too-large';
	try {
		await deps.copy(payload.text);
		return 'copied';
	} catch {
		return 'failed';
	}
}

/**
 * Save text as a file through a transient object-URL link. The URL is released a moment later, not right after the
 * click: some browsers start the download only after the click handler has returned.
 *
 * @param text - The file's text.
 * @param mime - Its media type.
 * @param fileName - The suggested file name.
 */
export function browserDownload(text: string, mime: string, fileName: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: mime }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	try {
		anchor.click();
	} finally {
		document.body.removeChild(anchor);
		setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
	}
}

/**
 * Put text on the clipboard. Rejects where the Clipboard API is missing or refuses (no user gesture).
 *
 * @param text - The text.
 * @returns When it is copied.
 */
export function browserCopy(text: string): Promise<void> {
	if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.reject(new Error('The clipboard is not available here.'));
	return navigator.clipboard.writeText(text);
}
