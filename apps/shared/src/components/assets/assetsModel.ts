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
// ASSETS MODEL — the pure half of PACKAGE › Assets (no React, no host)
// =============================================================================

/**
 * What the {@link AssetsPane} computes without a host: the icon admission
 * rule, the README reference list, caret insertion, the asset naming for
 * dropped and pasted images, the reference removal, and the path grammar
 * both hosts apply to a path beside the document. Hosts import the path
 * helpers (a VS Code extension host and the cloud workspace both answer
 * the same containment question); the pane imports the rest.
 */

import { normalizePosixPath, scanReadmeReferences } from 'rocketride';

// =============================================================================
// THE HOST ADAPTER
// =============================================================================

/**
 * The file operations the pane needs from its host, every path '/'-separated
 * and relative to the DOCUMENT's folder (the `.pipe` file's folder, or the
 * app folder). The pane never sees an absolute path.
 */
export interface IAssetsHost {
	/** A UTF-8 text file beside the document; null when it does not exist. */
	readFile(relPath: string): Promise<string | null>;
	/** An image beside the document as a `data:` URI (thumbnails, the icon tile); null when missing or not an image. */
	readImageDataUri(relPath: string): Promise<string | null>;
	/** Writes a file beside the document, creating folders as needed. */
	writeFile(relPath: string, data: Uint8Array | string): Promise<void>;
	/** The host's native picker; null on cancel. */
	pickFile(accept: 'image' | 'markdown'): Promise<{ name: string; data: Uint8Array } | null>;
	/** "Open in editor": the host opens the file in its own text editor. Absent = no editor on this host. */
	openFile?(relPath: string): Promise<void>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The icon size cap. The SDK's `MAX_ICON_BYTES` (rocketride/app-pack) is
 * the same number but that entry point imports Node's fs, so the pane
 * carries its own copy; the packer refuses larger icons with the same cap.
 */
export const MAX_ICON_BYTES = 256 * 1024;

/** The one-line refusal when the icon is not an SVG or PNG. */
export const ICON_TYPE_MESSAGE = 'Icons are SVG or PNG files.';

/** The one-line refusal when the icon is over the cap. */
export const ICON_SIZE_MESSAGE = 'Icons are at most 256 KB.';

/** The debounce for README text edits before they reach the file (ms). */
export const README_WRITE_DEBOUNCE_MS = 300;

/** The image extensions the pane shows as thumbnails and inserts as `![..](..)`. */
const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

/** The folder beside the README that dropped and pasted images land in. */
export const ASSETS_DIR = 'assets';

// =============================================================================
// PATHS (posix, relative to the document)
// =============================================================================

/**
 * The path a host serves for a request beside the document: normalised,
 * and null when it is empty or escapes the document's folder. Both hosts
 * apply this to every read, write, pick target and open.
 *
 * @param relPath - The requested path, either separator, './' allowed.
 * @returns The contained posix path, or null to refuse.
 */
export function besidePath(relPath: string): string | null {
	const rel = normalizePosixPath(relPath);
	if (rel === '' || rel.split('/')[0] === '..') return null;
	return rel;
}

/**
 * The posix directory of a document-relative path ('' at the document's folder).
 *
 * @param relPath - The path.
 * @returns Its directory part.
 */
export function posixDirname(relPath: string): string {
	const rel = normalizePosixPath(relPath);
	const slash = rel.lastIndexOf('/');
	return slash < 0 ? '' : rel.slice(0, slash);
}

/**
 * Joins a directory and a name into one normalised posix path.
 *
 * @param dir - The directory ('' for the document's folder).
 * @param name - The entry under it.
 * @returns The joined path.
 */
export function posixJoin(dir: string, name: string): string {
	return normalizePosixPath(dir ? `${dir}/${name}` : name);
}

/**
 * The file name of a path.
 *
 * @param relPath - The path.
 * @returns The last segment.
 */
export function posixBasename(relPath: string): string {
	const rel = normalizePosixPath(relPath);
	return rel.slice(rel.lastIndexOf('/') + 1);
}

/**
 * The lower-cased extension of a name ('' when none).
 *
 * @param name - A file name or path.
 * @returns The extension without the dot.
 */
export function extensionOf(name: string): string {
	const base = posixBasename(name);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Whether a name is one of the image types the pane thumbnails.
 *
 * @param name - A file name or path.
 * @returns True for svg/png/jpg/jpeg/gif/webp.
 */
export function isImageName(name: string): boolean {
	return IMAGE_EXTENSIONS.has(extensionOf(name));
}

// =============================================================================
// THE ICON
// =============================================================================

/** The admitted icon kinds and the file each is written as beside the document. */
export type IconKind = 'svg' | 'png';

/**
 * Judges a candidate icon file: SVG or PNG by extension or media type, at
 * most {@link MAX_ICON_BYTES}.
 *
 * @param file - The candidate's name, media type (when the source knows it) and size.
 * @returns The kind to write, or the one-line refusal.
 */
export function admitIcon(file: { name: string; type?: string; size: number }): { kind: IconKind } | { error: string } {
	// Step 1: the kind, by media type first (a paste has no useful name), then by extension
	const type = (file.type ?? '').toLowerCase();
	const ext = extensionOf(file.name);
	let kind: IconKind | null = null;
	if (type === 'image/svg+xml' || ext === 'svg') kind = 'svg';
	else if (type === 'image/png' || ext === 'png') kind = 'png';
	if (kind === null) return { error: ICON_TYPE_MESSAGE };
	// Step 2: the cap
	if (file.size > MAX_ICON_BYTES) return { error: ICON_SIZE_MESSAGE };
	return { kind };
}

/**
 * The path an admitted icon is written to and declared as: `./icon.svg` or `./icon.png`.
 *
 * @param kind - The admitted kind.
 * @returns The declared path (the './' form the scaffold stamps).
 */
export function iconPathFor(kind: IconKind): string {
	return `./icon.${kind}`;
}

/**
 * The byte count a `data:` URI carries (base64 payloads decoded, text
 * payloads measured as UTF-8) — the size shown beside the icon tile.
 *
 * @param dataUri - The URI.
 * @returns The payload size in bytes.
 */
export function dataUriByteLength(dataUri: string): number {
	const comma = dataUri.indexOf(',');
	if (comma < 0) return 0;
	const header = dataUri.slice(0, comma);
	const payload = dataUri.slice(comma + 1);
	if (/;base64$/i.test(header)) {
		const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
		return Math.floor((payload.length * 3) / 4) - padding;
	}
	return new TextEncoder().encode(decodeURIComponent(payload)).length;
}

/**
 * A byte count as the pane prints it: `1.2 KB`, `640 B`, `3.1 MB`.
 *
 * @param bytes - The count.
 * @returns The label.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// THE README
// =============================================================================

/** One file the README references, resolved against the README. */
export interface IReadmeReference {
	/** The reference as written in the markdown. */
	ref: string;
	/** The file's path relative to the DOCUMENT (the README's folder applied). */
	relPath: string;
	/** Whether the pane shows it as an image thumbnail. */
	isImage: boolean;
}

/**
 * The local files a README references, each resolved against the README's
 * own folder to a document-relative path; a reference that escapes upward
 * keeps its leading `..` so the pane can show it as missing.
 *
 * @param markdown - The README text.
 * @param readmePath - The README's document-relative path.
 * @returns The references in order of appearance, de-duplicated by path.
 */
export function readmeReferences(markdown: string, readmePath: string): IReadmeReference[] {
	const dir = posixDirname(readmePath);
	const seen = new Set<string>();
	const out: IReadmeReference[] = [];
	for (const ref of scanReadmeReferences(markdown)) {
		const relPath = posixJoin(dir, ref);
		if (relPath === '' || seen.has(relPath)) continue;
		seen.add(relPath);
		out.push({ ref, relPath, isImage: isImageName(relPath) });
	}
	return out;
}

/**
 * Inserts a snippet at a caret, on its own line when the caret is mid-line:
 * a newline is added before it when the preceding text does not end with
 * one, and after it when the following text does not start with one.
 *
 * @param text - The document.
 * @param caret - The insertion offset (`selectionStart`), clamped to the text.
 * @param snippet - What to insert.
 * @returns The new text and the caret after the insertion.
 */
export function insertAtCaret(text: string, caret: number, snippet: string): { text: string; caret: number } {
	const at = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, at);
	const after = text.slice(at);
	const lead = before === '' || before.endsWith('\n') ? '' : '\n';
	const trail = after === '' || after.startsWith('\n') ? '' : '\n';
	const inserted = `${lead}${snippet}${trail}`;
	return { text: `${before}${inserted}${after}`, caret: at + lead.length + snippet.length };
}

/** The stem of a file name (no extension). */
function stemOf(name: string): string {
	const base = posixBasename(name);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? base : base.slice(0, dot);
}

/** Escapes text for an HTML attribute value. */
function attributeValue(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The `<img>` tag the pane writes for an image reference: `src`, `alt`, and
 * `width="N"` only when a width is given — no default width, so an SVG
 * renders at its own size until the author asks for one.
 *
 * @param src - The image path relative to the README.
 * @param alt - The alt text.
 * @param width - The display width in pixels, or null for none.
 * @returns The tag.
 */
export function imageTag(src: string, alt: string, width: number | null): string {
	const size = width !== null && Number.isFinite(width) && width > 0 ? ` width="${Math.round(width)}"` : '';
	return `<img src="${attributeValue(src)}" alt="${attributeValue(alt)}"${size}>`;
}

/**
 * The markdown that references an asset: an `<img>` tag for image types
 * (the form that can carry a width), a link otherwise. The alt text is the
 * file's stem.
 *
 * @param assetRelPath - The asset's path relative to the README (`assets/x.png`).
 * @returns The markdown snippet.
 */
export function assetMarkdown(assetRelPath: string): string {
	const stem = stemOf(assetRelPath);
	return isImageName(assetRelPath) ? imageTag(assetRelPath, stem, null) : `[${stem}](${assetRelPath})`;
}

/** The first `<img>` tag whose src is the reference, with its attributes. */
function findImageTag(markdown: string, ref: string): RegExpMatchArray | null {
	return markdown.match(new RegExp(`<img\\b([^>]*)\\ssrc=["']${escapeRegExp(ref)}["']([^>]*)>`, 'i'));
}

/**
 * The display width an image reference carries: the `width` attribute of
 * the first `<img>` written with that src, or null when the reference is a
 * markdown image or has no width.
 *
 * @param markdown - The README text.
 * @param ref - The reference as written.
 * @returns The width in pixels, or null.
 */
export function referenceWidth(markdown: string, ref: string): number | null {
	const tag = findImageTag(markdown, ref);
	if (!tag) return null;
	const attribute = `${tag[1]} ${tag[2]}`.match(/\swidth=["']?(\d+)/i);
	return attribute ? Number(attribute[1]) : null;
}

/**
 * Rewrites every reference to one image so it carries the given width (or
 * none): a markdown `![alt](ref)` becomes the `<img>` form (its alt kept),
 * an existing `<img>` keeps its other attributes and gets its `width`
 * replaced, added or removed.
 *
 * @param markdown - The README text.
 * @param ref - The reference as written.
 * @param width - The width in pixels, or null to remove the attribute.
 * @returns The rewritten text (unchanged when nothing references the image).
 */
export function setReferenceWidth(markdown: string, ref: string, width: number | null): string {
	const target = escapeRegExp(ref);
	const size = width !== null && Number.isFinite(width) && width > 0 ? ` width="${Math.round(width)}"` : '';
	// Step 1: markdown images become img tags
	const fromMarkdown = markdown.replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*<?${target}>?(?:\\s+"[^"]*")?\\s*\\)`, 'g'), (_m, alt: string) => imageTag(ref, alt, width));
	// Step 2: img tags keep their other attributes, width replaced or dropped
	return fromMarkdown.replace(new RegExp(`<img\\b([^>]*\\ssrc=["']${target}["'][^>]*)>`, 'gi'), (_m, attrs: string) => {
		const rest = attrs.replace(/\swidth=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s+$/, '');
		return `<img${rest}${size}>`;
	});
}

/**
 * A file name safe to write beside the README: the basename only, spaces
 * to dashes, anything outside letters, digits, dot, dash and underscore
 * dropped; an empty result becomes `file`.
 *
 * @param name - The name as the source gave it.
 * @returns The sanitised name.
 */
export function safeAssetName(name: string): string {
	const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
	const cleaned = base.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
	return cleaned === '' ? 'file' : cleaned;
}

/**
 * The name a pasted image gets: `<docStem>-<n>.png`.
 *
 * @param docStem - The document's stem (the pipeline id or the app slug).
 * @param n - The 1-based paste ordinal.
 * @returns The file name.
 */
export function pastedImageName(docStem: string, n: number): string {
	return `${safeAssetName(docStem) || 'image'}-${n}.png`;
}

/**
 * The first name that does not collide: `name.ext`, then `name-2.ext`,
 * `name-3.ext`, ... — the ordinal is appended before the extension.
 *
 * @param name - The wanted name.
 * @param exists - Whether a name is taken (document-relative check done by the caller).
 * @returns The free name.
 */
export async function uniqueAssetName(name: string, exists: (candidate: string) => Promise<boolean>): Promise<string> {
	if (!(await exists(name))) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot <= 0 ? name : name.slice(0, dot);
	const ext = dot <= 0 ? '' : name.slice(dot);
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}${ext}`;
		if (!(await exists(candidate))) return candidate;
	}
}

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes every reference to one file from the README text: markdown images
 * and links written with that reference (`![alt](ref)`, `[text](ref)`,
 * with or without a title) and HTML `<img>` tags whose `src` is it. A line
 * left empty by the removal is dropped so no blank hole remains. The file
 * itself is untouched.
 *
 * @param markdown - The README text.
 * @param ref - The reference as written (see {@link IReadmeReference.ref}).
 * @returns The text without the reference.
 */
export function removeReference(markdown: string, ref: string): string {
	const target = escapeRegExp(ref);
	const markdownRef = new RegExp(`!?\\[[^\\]]*\\]\\(\\s*<?${target}>?(?:\\s+"[^"]*")?\\s*\\)`, 'g');
	const htmlImg = new RegExp(`<img\\b[^>]*\\ssrc=["']${target}["'][^>]*>`, 'gi');
	const stripped = markdown.replace(markdownRef, '').replace(htmlImg, '');
	if (stripped === markdown) return markdown;
	// Step: drop the lines the removal emptied (only those that held a reference)
	const before = markdown.split('\n');
	const after = stripped.split('\n');
	return after.filter((line, i) => !(line.trim() === '' && before[i] !== undefined && before[i].trim() !== '')).join('\n');
}

/**
 * Replaces every local image reference in the markdown with the data: URI
 * the resolver answers, so the preview renders workspace images without a
 * URL to fetch them from. References the resolver cannot answer stay as
 * written (the preview then shows them broken, which is honest).
 *
 * @param markdown - The README text.
 * @param resolve - The data: URI for a reference as written (null = leave it).
 * @returns The markdown with the resolvable images inlined.
 */
export async function inlineImageReferences(markdown: string, resolve: (ref: string) => Promise<string | null>): Promise<string> {
	const inlined = new Map<string, string>();
	for (const ref of scanReadmeReferences(markdown)) {
		if (!isImageName(ref)) continue;
		const uri = await resolve(ref).catch(() => null);
		if (uri) inlined.set(ref, uri);
	}
	if (inlined.size === 0) return markdown;
	const swap = (ref: string): string => inlined.get(ref) ?? inlined.get(safeDecode(ref)) ?? ref;
	return markdown
		.replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?\s*\))/g, (m, pre: string, ref: string, post: string) => (swap(ref) !== ref ? `${pre}${swap(ref)}${post}` : m))
		.replace(/(<img\b[^>]*\ssrc=["'])([^"']+)(["'])/gi, (m, pre: string, ref: string, post: string) => (swap(ref) !== ref ? `${pre}${swap(ref)}${post}` : m));
}

/** Percent-decodes when the text is a valid encoding; the text otherwise. */
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * The line count of a README as the footer prints it (a trailing newline
 * does not add a line; an empty text is one line).
 *
 * @param text - The README text.
 * @returns The count.
 */
export function lineCount(text: string): number {
	if (text === '') return 1;
	const body = text.endsWith('\n') ? text.slice(0, -1) : text;
	return body.split('\n').length;
}

// =============================================================================
// DOWNSCALE — raster images the pane writes fit inside 1024 x 800
// =============================================================================

/** The box every inserted raster image is scaled to fit (never upscaled). */
export const MAX_ASSET_WIDTH = 1024;
export const MAX_ASSET_HEIGHT = 800;

/** The JPEG and WebP re-encode quality. */
const RASTER_QUALITY = 0.85;

/** The raster types the pane re-encodes; SVG (no pixels) and GIF (animation) pass through. */
const DOWNSCALED_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
};

/**
 * The size an image takes inside the box: shrunk to fit with its aspect
 * kept, never grown. The pure math behind {@link downscaleImage}.
 *
 * @param width - The source width.
 * @param height - The source height.
 * @param maxWidth - The box width.
 * @param maxHeight - The box height.
 * @returns The target size and whether it differs from the source.
 */
export function fitWithin(width: number, height: number, maxWidth: number = MAX_ASSET_WIDTH, maxHeight: number = MAX_ASSET_HEIGHT): { width: number; height: number; scaled: boolean } {
	if (width <= 0 || height <= 0) return { width, height, scaled: false };
	const ratio = Math.min(maxWidth / width, maxHeight / height);
	if (ratio >= 1) return { width, height, scaled: false };
	return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), scaled: true };
}

/**
 * Scales a raster image to fit {@link MAX_ASSET_WIDTH} x {@link MAX_ASSET_HEIGHT}
 * in the browser (a canvas in the webview and the page alike) and re-encodes
 * it in its own format: PNG stays PNG, JPEG and WebP at {@link RASTER_QUALITY}.
 * An image that already fits, an SVG, a GIF, a non-image, and any decode or
 * encode failure all answer the original bytes.
 *
 * @param name - The file name (its extension picks the format).
 * @param bytes - The image bytes.
 * @returns The bytes to write.
 */
export async function downscaleImage(name: string, bytes: Uint8Array): Promise<Uint8Array> {
	const type = DOWNSCALED_TYPES[extensionOf(name)];
	if (!type || typeof createImageBitmap !== 'function') return bytes;
	try {
		// Step 1: decode and measure (a fresh copy: a Blob part must sit on a plain ArrayBuffer)
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
		try {
			const fit = fitWithin(bitmap.width, bitmap.height);
			if (!fit.scaled) return bytes;
			// Step 2: draw at the fitted size and re-encode in the same format
			const blob = await encodeBitmap(bitmap, fit.width, fit.height, type);
			return blob ? new Uint8Array(await blob.arrayBuffer()) : bytes;
		} finally {
			bitmap.close();
		}
	} catch {
		return bytes;
	}
}

/** Draws a bitmap onto a canvas of the given size and encodes it. */
async function encodeBitmap(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob | null> {
	const quality = type === 'image/png' ? undefined : RASTER_QUALITY;
	if (typeof OffscreenCanvas === 'function') {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.drawImage(bitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type, quality });
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.drawImage(bitmap, 0, 0, width, height);
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

// =============================================================================
// BYTES ON THE WIRE
// =============================================================================

/**
 * Base64 of a byte array — the shape bytes take over a webview bridge
 * (strings only), chunked so large files never overflow the call stack.
 *
 * @param bytes - The bytes.
 * @returns The base64 text.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.byteLength; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(binary);
}

/**
 * The bytes of a base64 text.
 *
 * @param base64 - The base64 text.
 * @returns The bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * A `data:` URI for image bytes, by the file's extension.
 *
 * @param name - The file name (its extension picks the media type).
 * @param bytes - The image bytes.
 * @returns The URI, or null for a non-image extension.
 */
export function imageDataUri(name: string, bytes: Uint8Array): string | null {
	const mediaType = IMAGE_MEDIA_TYPES[extensionOf(name)];
	return mediaType ? `data:${mediaType};base64,${bytesToBase64(bytes)}` : null;
}

/** The media type of each image extension the pane handles. */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};
