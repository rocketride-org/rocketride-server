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
// VECTOR - FILE TYPES (pure): the upload allowlist, type labels, MIME types, sizes
// =============================================================================
//
// One list of the file types the console accepts (the drop zone checks it
// before sending; the parser refuses what it cannot read anyway), the label
// the directory shows for a stored path, and the MIME type sent with an upload.
// =============================================================================

/** The extensions a drop accepts, in the order the drop zone names them. */
export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'rtf', 'txt', 'md', 'csv', 'html', 'json'] as const;

/** One accepted extension. */
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** What each type is called in the directory. */
const LABELS: Readonly<Record<AllowedExtension, string>> = {
	pdf: 'PDF',
	docx: 'Word document',
	pptx: 'PowerPoint presentation',
	xlsx: 'Excel workbook',
	odt: 'OpenDocument text',
	rtf: 'Rich text',
	txt: 'Text',
	md: 'Markdown',
	csv: 'CSV',
	html: 'HTML',
	json: 'JSON',
};

/** The MIME type sent with each. */
const MIME: Readonly<Record<AllowedExtension, string>> = {
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

/**
 * The extension of a path's file name, lower case.
 *
 * @param path - A path or a file name.
 * @returns The extension without the dot, or null when the name has none.
 */
export function extensionOf(path: string): string | null {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

/** Whether an extension is on the allowlist. */
function allowed(ext: string | null): ext is AllowedExtension {
	return ext !== null && (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Whether a file may be dropped.
 *
 * @param name - The file name or path.
 * @returns True for an allowed extension.
 */
export function isAllowedFile(name: string): boolean {
	return allowed(extensionOf(name));
}

/**
 * The type label of a stored path.
 *
 * @param path - The path.
 * @returns e.g. 'PDF', or 'File' for anything else.
 */
export function fileTypeOf(path: string): string {
	const ext = extensionOf(path);
	return allowed(ext) ? LABELS[ext] : 'File';
}

/**
 * The MIME type to send with a file.
 *
 * @param name - The file name.
 * @returns The type, or undefined (the SDK then uses the file's own).
 */
export function mimeTypeOf(name: string): string | undefined {
	const ext = extensionOf(name);
	return allowed(ext) ? MIME[ext] : undefined;
}

/**
 * A size in binary units.
 *
 * @param bytes - The size, or null when the store does not keep it.
 * @returns e.g. '7.2 KB', or '—'.
 */
export function formatSize(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded.toLocaleString('en-US')} ${units[unit]}`;
}
