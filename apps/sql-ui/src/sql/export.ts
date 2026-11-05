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
// SQL — EXPORT (a result as CSV, JSON or Markdown)
// =============================================================================
//
// The results card's Export button. CSV and JSON download as files; Markdown
// is copied, for pasting into a ticket or a chat. A VS Code webview refuses
// downloads, so there CSV and JSON are copied too, and the announcement says
// which happened.
//
// Every format follows the statement's columns as captured when it settled
// (sql/batch.ts settleStatement), never the keys of a row object: the grid
// writes its columns' keys into the rows it renders.
//
// CSV follows RFC 4180: CRLF between records, and a field holding a comma, a
// quote or a line break is quoted with its quotes doubled. NULL is an empty
// field and an empty string is `""`, so the two stay apart (PostgreSQL's
// COPY ... CSV reads them back the same way). Objects and arrays are written
// as JSON text. Values are exported as they reached the browser, so the
// precision note under the grid applies to the file too.
//
// A spreadsheet runs a CSV cell that starts with `=`, `+`, `-` or `@` as a
// formula, and query results can hold text anyone typed. So in CSV only, a
// TEXT value that starts with one of those, or with a tab or a carriage
// return, gets a leading `'` (OWASP's CSV injection rule). Numbers keep their
// sign, and JSON and Markdown keep the text as it is.
// =============================================================================

/** The CSV guard, in the export menu's words. */
export const CSV_FORMULA_NOTE = "CSV: text that starts with = + - or @ gets a leading ' so spreadsheets do not run it.";

/** Text a spreadsheet would read as a formula (or as the start of one). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** How long a download's object URL is kept before it is released. */
const DOWNLOAD_URL_LIFETIME_MS = 1000;

/** The formats the Export button offers. */
export type ExportFormat = 'csv' | 'json' | 'markdown';

/** One export, ready to deliver. */
export interface ExportPayload {
	/** The file's text. */
	text: string;
	/** Its media type. */
	mime: string;
	/** Its file extension, without the dot. */
	extension: string;
}

/**
 * How a delivery ended. `downloaded` means the browser was handed the file:
 * a page that blocks downloads without saying so cannot be detected.
 */
export type ExportDelivery = 'downloaded' | 'copied' | 'failed';

/** What delivering needs from the page (injected, so the rule is testable). */
export interface ExportDeliveryDeps {
	/** True where downloads are refused (a VS Code webview). */
	downloadsRefused: boolean;
	/** Save the text as a file. Throws when the page refuses. */
	download(text: string, mime: string, fileName: string): void;
	/** Put the text on the clipboard. Rejects when refused. */
	copy(text: string): Promise<void>;
}

// =============================================================================
// FORMATS
// =============================================================================

/**
 * One value as text: objects and arrays as JSON, everything else as String.
 *
 * @param value - A non-null value.
 * @returns The text.
 */
function valueText(value: unknown): string {
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * One CSV field: NULL empty, an empty string `""`, text a spreadsheet would
 * run as a formula behind a `'`, and a field holding a comma, a quote or a
 * line break quoted with its quotes doubled.
 *
 * @param value - The raw value.
 * @returns The field.
 */
function csvField(value: unknown): string {
	if (value === null || value === undefined) return '';
	const raw = valueText(value);
	if (raw === '') return '""';
	const text = typeof value === 'string' && FORMULA_START.test(raw) ? `'${raw}` : raw;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A result as RFC 4180 CSV, header first.
 *
 * @param columns - The statement's captured columns, in order.
 * @param rows - The rows.
 * @returns The CSV text.
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
	const lines = [columns.map(csvField).join(',')];
	for (const row of rows) lines.push(columns.map((column) => csvField(row[column])).join(','));
	return lines.join('\r\n');
}

/**
 * A result as a JSON array of objects, keys in column order and a missing
 * value as null.
 *
 * @param columns - The statement's captured columns, in order.
 * @param rows - The rows.
 * @returns The JSON text.
 */
export function toJson(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
	return JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))), null, '\t');
}

/**
 * One Markdown table cell: NULL spelled out, pipes escaped, line breaks as
 * `<br>`.
 *
 * @param value - The raw value.
 * @returns The cell text.
 */
function markdownCell(value: unknown): string {
	const text = value === null || value === undefined ? 'NULL' : valueText(value);
	return text.replace(/\|/g, '\\|').replace(/\r?\n|\r/g, '<br>');
}

/**
 * A result as a Markdown pipe table.
 *
 * @param columns - The statement's captured columns, in order.
 * @param rows - The rows.
 * @returns The table text.
 */
export function toMarkdown(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
	const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
	return [
		line(columns.map(markdownCell)),
		line(columns.map(() => '---')),
		...rows.map((row) => line(columns.map((column) => markdownCell(row[column])))),
	].join('\n');
}

/**
 * A result in one format.
 *
 * @param format - The format.
 * @param columns - The statement's captured columns, in order.
 * @param rows - The rows.
 * @returns The payload.
 */
export function exportResult(format: ExportFormat, columns: readonly string[], rows: readonly Record<string, unknown>[]): ExportPayload {
	switch (format) {
		case 'csv': return { text: toCsv(columns, rows), mime: 'text/csv;charset=utf-8', extension: 'csv' };
		case 'json': return { text: toJson(columns, rows), mime: 'application/json', extension: 'json' };
		default: return { text: toMarkdown(columns, rows), mime: 'text/markdown;charset=utf-8', extension: 'md' };
	}
}

/**
 * The file name for one statement's export, e.g. `query-3-statement-2.csv`.
 *
 * @param label - The query document's label ("Query 3").
 * @param index - The statement's zero-based index in its batch.
 * @param format - The format.
 * @returns The file name.
 */
export function exportFileName(label: string, index: number, format: ExportFormat): string {
	const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
	return `${stem}-statement-${index + 1}.${exportResult(format, [], []).extension}`;
}

// =============================================================================
// DELIVERY
// =============================================================================

/**
 * Deliver an export: Markdown, and anything where downloads are refused or
 * fail, goes to the clipboard; CSV and JSON otherwise download.
 *
 * @param payload - The export and its file name.
 * @param deps - The page's download and clipboard.
 * @returns How it ended.
 */
export async function deliverExport(payload: ExportPayload & { fileName: string }, deps: ExportDeliveryDeps): Promise<ExportDelivery> {
	if (payload.extension !== 'md' && !deps.downloadsRefused) {
		try {
			deps.download(payload.text, payload.mime, payload.fileName);
			return 'downloaded';
		} catch {
			// Refused by the page: the clipboard is the fallback.
		}
	}
	try {
		await deps.copy(payload.text);
		return 'copied';
	} catch {
		return 'failed';
	}
}

/**
 * Save text as a file through a transient object-URL link. The URL is
 * released a moment later, not right after the click: some browsers start
 * the download only after the click handler has returned.
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
 * Put text on the clipboard. Rejects where the Clipboard API is missing (an
 * insecure context) or refuses (no user gesture).
 *
 * @param text - The text.
 * @returns When it is copied.
 */
export function browserCopy(text: string): Promise<void> {
	if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.reject(new Error('The clipboard is not available here.'));
	return navigator.clipboard.writeText(text);
}
