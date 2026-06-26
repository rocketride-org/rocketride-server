// MIT License
//
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
// MEDIA TYPES — file extension → viewer category + MIME type
// =============================================================================

/** The viewer category determines which pane component renders the file. */
export type FileCategory = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'docx' | 'spreadsheet' | 'markdown' | 'json' | 'binary';

/**
 * How the VFS delivers file data to the viewer.
 *
 * - `'inline'`  — content is the actual file data (text string).
 * - `'link'`    — content is a presigned URL for native streaming
 *                 (video/audio).  Ephemeral — refreshed on mount.
 * - `'blob'`    — data is fetched from a presigned URL and served as
 *                 a local blob URL (images, PDF, docx, spreadsheets).
 */
export type ContentMode = 'inline' | 'link' | 'blob';

interface MediaInfo {
	category: FileCategory;
	mime: string;
	contentMode: ContentMode;
}

/** Extension → MediaInfo lookup (lowercase, with leading dot). */
const MEDIA_MAP: Record<string, MediaInfo> = {
	// Images — blob (fetched and served as blob URL)
	'.png':  { category: 'image', mime: 'image/png',       contentMode: 'blob' },
	'.jpg':  { category: 'image', mime: 'image/jpeg',      contentMode: 'blob' },
	'.jpeg': { category: 'image', mime: 'image/jpeg',      contentMode: 'blob' },
	'.gif':  { category: 'image', mime: 'image/gif',       contentMode: 'blob' },
	'.webp': { category: 'image', mime: 'image/webp',      contentMode: 'blob' },
	'.svg':  { category: 'image', mime: 'image/svg+xml',   contentMode: 'blob' },
	'.bmp':  { category: 'image', mime: 'image/bmp',       contentMode: 'blob' },
	'.ico':  { category: 'image', mime: 'image/x-icon',    contentMode: 'blob' },
	'.avif': { category: 'image', mime: 'image/avif',      contentMode: 'blob' },

	// Video — link (presigned URL for native streaming with Range support)
	'.mp4':  { category: 'video', mime: 'video/mp4',          contentMode: 'link' },
	'.webm': { category: 'video', mime: 'video/webm',         contentMode: 'link' },
	'.ogv':  { category: 'video', mime: 'video/ogg',          contentMode: 'link' },
	'.mov':  { category: 'video', mime: 'video/quicktime',    contentMode: 'link' },
	'.avi':  { category: 'video', mime: 'video/x-msvideo',    contentMode: 'link' },
	'.mkv':  { category: 'video', mime: 'video/x-matroska',   contentMode: 'link' },

	// Audio — link (presigned URL for native streaming with Range support)
	'.mp3':  { category: 'audio', mime: 'audio/mpeg', contentMode: 'link' },
	'.wav':  { category: 'audio', mime: 'audio/wav',  contentMode: 'link' },
	'.ogg':  { category: 'audio', mime: 'audio/ogg',  contentMode: 'link' },
	'.flac': { category: 'audio', mime: 'audio/flac', contentMode: 'link' },
	'.aac':  { category: 'audio', mime: 'audio/aac',  contentMode: 'link' },
	'.m4a':  { category: 'audio', mime: 'audio/mp4',  contentMode: 'link' },
	'.weba': { category: 'audio', mime: 'audio/webm', contentMode: 'link' },

	// PDF — blob (fetched and served as blob URL for iframe)
	'.pdf':  { category: 'pdf', mime: 'application/pdf', contentMode: 'blob' },

	// JSON — inline (read as text, rendered with syntax highlighting)
	'.json':     { category: 'json', mime: 'application/json',   contentMode: 'inline' },
	'.jsonl':    { category: 'json', mime: 'application/jsonl',  contentMode: 'inline' },
	'.geojson':  { category: 'json', mime: 'application/geo+json', contentMode: 'inline' },

	// Markdown — inline (read as text, rendered via MarkdownRenderer)
	'.md':       { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.markdown': { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mdx':      { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mdown':    { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mkd':      { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },
	'.mkdn':     { category: 'markdown', mime: 'text/markdown', contentMode: 'inline' },

	// MS Word — blob (fetched and decoded by docx-preview)
	'.docx': { category: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentMode: 'blob' },
	'.doc':  { category: 'docx', mime: 'application/msword', contentMode: 'blob' },

	// Spreadsheets — blob (fetched and decoded by SheetJS)
	'.xlsx': { category: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentMode: 'blob' },
	'.xls':  { category: 'spreadsheet', mime: 'application/vnd.ms-excel', contentMode: 'blob' },
	'.csv':  { category: 'spreadsheet', mime: 'text/csv', contentMode: 'blob' },
};

/**
 * Returns the viewer category, MIME type, and content mode for a file path.
 * Defaults to inline text for unrecognised extensions.
 */
export function getMediaInfo(path: string): MediaInfo {
	const dotIdx = path.lastIndexOf('.');
	if (dotIdx < 0) return { category: 'text', mime: 'text/plain', contentMode: 'inline' };
	const ext = path.substring(dotIdx).toLowerCase();
	return MEDIA_MAP[ext] ?? { category: 'text', mime: 'text/plain', contentMode: 'inline' };
}


