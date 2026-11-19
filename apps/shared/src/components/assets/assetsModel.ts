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
	/**
	 * A UTF-8 text file beside the document; null ONLY when it does not exist.
	 * Any other failure (over a cap, unreadable) rejects, so the pane never
	 * offers a stub over a file that is there.
	 */
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

/** An absolute spelling, either separator: posix-rooted, drive-qualified or UNC. */
const ABSOLUTE_PATH_RE = /^(?:[\\/]|[A-Za-z]:)/;

/**
 * The path a host serves for a request beside the document: normalised,
 * and null when it is empty, absolute or escapes the document's folder.
 * Both hosts apply this to every read, write, pick target and open.
 *
 * @param relPath - The requested path, either separator, './' allowed.
 * @returns The contained posix path, or null to refuse.
 */
export function besidePath(relPath: string): string | null {
	// Step 1: an absolute path is never beside the document — refused as
	// written, before normalising would quietly make it relative
	if (ABSOLUTE_PATH_RE.test(relPath)) return null;
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

// =============================================================================
// REFERENCE MATCHING — the spelling in the text against the scanner's reference
// =============================================================================

/** Code the SDK scanner skips (fenced blocks and inline spans): an example is never a live reference. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * A markdown image or link: `![alt](dest "title")`, `[text](dest)`; groups:
 * the `!`, the text, the destination, the title part. The destination is
 * the SDK scanner's: one level of balanced parentheses allowed
 * (`plot(1).png`), so every reference the scanner lists is one the edits find.
 */
const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()]*\))+)>?((?:\s+"[^"]*")?)\s*\)/g;

/** An HTML `<img>` tag (the tag name case-insensitive; the path inside is compared exactly); group 1 = its attribute text. */
const HTML_IMG_RE = /<img\b([^>]*)>/gi;

/**
 * One attribute in a tag's attribute text, as the HTML tokenizer reads it:
 * the name, then an optional `=` (spaces allowed around it) and a double-
 * quoted, single-quoted or bare value. Groups: the name, then the value by
 * quoting. Walking the text token by token is what keeps a `src=` inside
 * another attribute's value (`alt="see src='x'"`) from passing for the source.
 */
const ATTRIBUTE_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A character reference in an attribute value: hex numeric, decimal numeric or named; groups 2-4. */
const CHARACTER_REFERENCE_RE = /&(#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi;

/** The named character references an attribute value carries ({@link attributeValue} writes the first four; `&apos;` is the HTML5 name). */
const NAMED_CHARACTER_REFERENCES: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };

/**
 * Decodes the character references in an HTML attribute value, as the
 * browser reads it: `&amp;`, `&quot;`, `&#39;`, `&#x27;`, ... An unknown
 * reference stays as written. The SDK scanner and the Python SDK decode the
 * same way, so the file an `<img>` names is one file on every side.
 *
 * @param value - The value as written between the quotes.
 * @returns The decoded value.
 */
function decodeAttribute(value: string): string {
	return value.replace(CHARACTER_REFERENCE_RE, (m, _ref: string, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
		if (name !== undefined) return NAMED_CHARACTER_REFERENCES[name.toLowerCase()] ?? m;
		const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});
}

/** One attribute of an `<img>`: its name (lower-cased), its decoded value, and where both sit in the attribute text. */
interface IAttribute {
	name: string;
	/** The value as the browser reads it (character references decoded); the spans below are the source text's. */
	value: string;
	/** The token's span (name through closing quote). */
	start: number;
	end: number;
	/** The value's span (inside the quotes). */
	valueStart: number;
	valueEnd: number;
}

/** The attributes of a tag's attribute text, in order. */
function attributesOf(attrs: string): IAttribute[] {
	const out: IAttribute[] = [];
	for (const match of attrs.matchAll(ATTRIBUTE_RE)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		// Step: the spans come from the value as written; the value itself is decoded for matching
		const written = match[2] ?? match[3] ?? match[4] ?? '';
		const quoted = match[2] !== undefined || match[3] !== undefined;
		const valueEnd = end - (quoted ? 1 : 0);
		out.push({ name: match[1].toLowerCase(), value: decodeAttribute(written), start, end, valueStart: valueEnd - written.length, valueEnd });
	}
	return out;
}

/** The first attribute of a name (the one the browser keeps when it repeats), or undefined. */
function firstAttribute(attrs: string, name: string): IAttribute | undefined {
	return attributesOf(attrs).find((attribute) => attribute.name === name);
}

/** The attribute text without any attribute of the given name (each taken with the whitespace before it). */
function withoutAttribute(attrs: string, name: string): string {
	let out = attrs;
	for (const attribute of attributesOf(attrs).filter((candidate) => candidate.name === name).reverse()) {
		let from = attribute.start;
		while (from > 0 && /\s/.test(out[from - 1])) from--;
		out = out.slice(0, from) + out.slice(attribute.end);
	}
	return out;
}

/** A destination's predicate: which spellings an edit touches. */
type Admits = (dest: string) => boolean;

/**
 * The file a destination as written names, in the scanner's spelling: the
 * fragment and query dropped, percent-decoded, normalised — so
 * `assets/my%20shot.png?v=2` and `./assets/my shot.png` name one file.
 */
function canonicalRef(dest: string): string {
	return normalizePosixPath(safeDecode(dest.split('#')[0].split('?')[0]));
}

/** The predicate for one scanner reference (case-sensitive: `A.png` is not `a.png`). */
function names(ref: string): Admits {
	const wanted = normalizePosixPath(ref);
	return (dest) => canonicalRef(dest) === wanted;
}

/** Applies a text transform to the parts of the markdown outside code (each with its offset in the text), the code kept verbatim. */
function outsideCode(markdown: string, transform: (segment: string, offset: number) => string): string {
	let out = '';
	let last = 0;
	for (const match of markdown.matchAll(CODE_RE)) {
		const at = match.index ?? 0;
		out += transform(markdown.slice(last, at), last) + match[0];
		last = at + match[0].length;
	}
	return out + transform(markdown.slice(last), last);
}

/**
 * The lines a rewrite emptied, dropped — only those that held something
 * before, so no blank hole remains where a reference stood and the text's
 * own blank lines stay. Every rewrite here keeps the line count, so the two
 * texts line up by index.
 */
function dropEmptiedLines(before: string, after: string): string {
	if (after === before) return before;
	const was = before.split('\n');
	return after
		.split('\n')
		.filter((line, i) => !(line.trim() === '' && was[i] !== undefined && was[i].trim() !== ''))
		.join('\n');
}

// ── Reference-style references: `![alt][label]` over `[label]: dest` ─────────

/**
 * A markdown reference definition at a line start, the scanner's spelling:
 * `[label]: dest "title"`; groups: the text up to the destination, the
 * label, the destination, the rest of the line.
 */
const MARKDOWN_DEF_RE = /^([ \t]{0,3}\[([^\]]+)\]:[ \t]*<?)([^\s<>]+)(>?.*)$/gm;

/** A reference-style image or link usage: `![alt][label]`, `[text][label]`, collapsed `![label][]`; groups: the `!`, the text, the label. */
const MARKDOWN_REF_USAGE_RE = /(!?)\[([^\]]*)\]\[([^\]]*)\]/g;

/** A label as definitions and usages match (CommonMark: case-insensitive, inner whitespace collapsed). */
function labelKey(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The label a usage names: its own, or its text when collapsed (`![label][]`). */
function usageKey(text: string, label: string): string {
	return labelKey(label === '' ? text : label);
}

/**
 * The reference definitions outside code whose destination the predicate
 * admits: label key to destination as written. The first definition of a
 * label is the live one (CommonMark), so a later one never stands in.
 */
function admittedDefinitions(markdown: string, admits: Admits): Map<string, string> {
	const seen = new Set<string>();
	const found = new Map<string, string>();
	rewriteDefinitions(markdown, null, (prefix, label, dest, rest) => {
		const key = labelKey(label);
		if (!seen.has(key)) {
			seen.add(key);
			if (admits(dest)) found.set(key, dest);
		}
		return `${prefix}${dest}${rest}`;
	});
	return found;
}

/**
 * Rewrites the reference definitions outside code whose label is in the
 * set (every definition for null). A definition is one that starts its
 * line: a segment that opens mid-line (behind an inline code span) does not
 * start one.
 *
 * @param markdown - The README text.
 * @param labels - The label keys to rewrite, or null for all.
 * @param rewrite - The replacement for one definition (its prefix up to the destination, label, destination and the rest of the line).
 * @returns The rewritten text.
 */
function rewriteDefinitions(markdown: string, labels: Set<string> | null, rewrite: (prefix: string, label: string, dest: string, rest: string) => string): string {
	return outsideCode(markdown, (segment, offset) =>
		segment.replace(MARKDOWN_DEF_RE, (m, prefix: string, label: string, dest: string, rest: string, index: number) => {
			const atLineStart = index > 0 || offset === 0 || markdown[offset - 1] === '\n';
			return atLineStart && (labels === null || labels.has(labelKey(label))) ? rewrite(prefix, label, dest, rest) : m;
		})
	);
}

/**
 * Rewrites the reference-style usages outside code whose label is in the set.
 *
 * @param markdown - The README text.
 * @param labels - The label keys whose usages to rewrite.
 * @param imagesOnly - Leave plain links alone.
 * @param rewrite - The replacement for one usage (its `!`, text and label key).
 * @returns The rewritten text.
 */
function rewriteReferenceUsages(markdown: string, labels: Set<string>, imagesOnly: boolean, rewrite: (bang: string, text: string, key: string) => string): string {
	return outsideCode(markdown, (segment) =>
		segment.replace(MARKDOWN_REF_USAGE_RE, (m, bang: string, text: string, label: string) => {
			const key = usageKey(text, label);
			return (imagesOnly && bang === '') || !labels.has(key) ? m : rewrite(bang, text, key);
		})
	);
}

/**
 * A shortcut reference, `[label]` / `![label]`: a bracket pair that no `[`
 * (full or collapsed form), `(` (inline link) or `:` (definition) follows;
 * group 1 = the label. The pair must also not be the label half of a
 * two-bracket usage, which the caller checks by the character before it.
 */
const MARKDOWN_SHORTCUT_RE = /\[([^[\]]+)\](?![[(:])/g;

/**
 * The label keys of the set that no usage outside code still names. Full,
 * collapsed and shortcut forms all use a definition; the shortcut form is
 * one the edits leave as written (a bare `[label]` is also plain text), so
 * it only counts here, to keep its definition alive.
 */
function unusedLabels(markdown: string, labels: Set<string>): Set<string> {
	const used = new Set<string>();
	rewriteReferenceUsages(markdown, labels, false, (bang, text, key) => {
		used.add(key);
		return `${bang}[${text}][${key}]`;
	});
	// Step: shortcut usages, skipping the second pair of `[text][label]`
	outsideCode(markdown, (segment) => {
		for (const match of segment.matchAll(MARKDOWN_SHORTCUT_RE)) {
			const key = labelKey(match[1]);
			if (segment[(match.index ?? 0) - 1] !== ']' && labels.has(key)) used.add(key);
		}
		return segment;
	});
	return new Set([...labels].filter((key) => !used.has(key)));
}

/**
 * Rewrites the markdown images and links outside code whose destination the
 * predicate admits; the rest of the text is untouched.
 *
 * @param markdown - The README text.
 * @param admits - Which destinations to rewrite.
 * @param imagesOnly - Leave plain links alone.
 * @param rewrite - The replacement for one match (its `!`, text, destination and title part).
 * @returns The rewritten text.
 */
function rewriteMarkdownLinks(markdown: string, admits: Admits, imagesOnly: boolean, rewrite: (bang: string, text: string, dest: string, title: string) => string): string {
	return outsideCode(markdown, (segment) => segment.replace(MARKDOWN_LINK_RE, (m, bang: string, text: string, dest: string, title: string) => ((imagesOnly && bang === '') || !admits(dest) ? m : rewrite(bang, text, dest, title))));
}

/**
 * Rewrites the `<img>` tags outside code whose `src` the predicate admits.
 *
 * @param markdown - The README text.
 * @param admits - Which sources to rewrite.
 * @param rewrite - The replacement for one tag (its attribute text and its `src` attribute, the source as written in its value).
 * @returns The rewritten text.
 */
function rewriteImageTags(markdown: string, admits: Admits, rewrite: (attrs: string, src: IAttribute) => string): string {
	return outsideCode(markdown, (segment) =>
		segment.replace(HTML_IMG_RE, (tag, attrs: string) => {
			// Step: the real src attribute, never a `src=` inside another attribute's value
			const src = firstAttribute(attrs, 'src');
			return src && src.value !== '' && admits(src.value) ? rewrite(attrs, src) : tag;
		})
	);
}

/**
 * The display width an image reference carries: the `width` attribute of
 * the first `<img>` written with that src, or null when the reference is a
 * markdown image or has no width.
 *
 * @param markdown - The README text.
 * @param ref - The reference as the scanner lists it.
 * @returns The width in pixels, or null.
 */
export function referenceWidth(markdown: string, ref: string): number | null {
	// Step: the first matching tag's attribute text, collected through the rewriter (its output is discarded)
	const found: { attrs: string | null } = { attrs: null };
	rewriteImageTags(markdown, names(ref), (attrs) => {
		if (found.attrs === null) found.attrs = attrs;
		return '';
	});
	// Step: the same attribute reader the width edit uses, so `width = "50"` reads as it rewrites
	const digits = found.attrs === null ? undefined : firstAttribute(found.attrs, 'width')?.value.match(/^\s*(\d+)/);
	return digits ? Number(digits[1]) : null;
}

/**
 * Rewrites every live reference to one image so it carries the given width
 * (or none): a markdown `![alt](ref)` becomes the `<img>` form (its alt and
 * destination kept as written), an existing `<img>` keeps its other
 * attributes and gets its `width` replaced, added or removed. Code examples
 * are left alone.
 *
 * @param markdown - The README text.
 * @param ref - The reference as the scanner lists it.
 * @param width - The width in pixels, or null to remove the attribute.
 * @returns The rewritten text (unchanged when nothing references the image).
 */
export function setReferenceWidth(markdown: string, ref: string, width: number | null): string {
	const admits = names(ref);
	const size = width !== null && Number.isFinite(width) && width > 0 ? ` width="${Math.round(width)}"` : '';
	// Step 0: reference-style images (`![alt][label]`) become img tags over the
	// definition's destination; a definition nothing else uses any more goes
	const definitions = admittedDefinitions(markdown, admits);
	const labels = new Set(definitions.keys());
	const fromUsages = rewriteReferenceUsages(markdown, labels, true, (_bang, alt, key) => imageTag(definitions.get(key) ?? '', alt, width));
	const fromReferences = dropEmptiedLines(fromUsages, rewriteDefinitions(fromUsages, unusedLabels(fromUsages, labels), () => ''));
	// Step 1: markdown images become img tags
	const fromMarkdown = rewriteMarkdownLinks(fromReferences, admits, true, (_bang, alt, dest) => imageTag(dest, alt, width));
	// Step 2: img tags keep their other attributes, width replaced or dropped
	return rewriteImageTags(fromMarkdown, admits, (attrs) => `<img${withoutAttribute(attrs, 'width').replace(/\s+$/, '')}${size}>`);
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
 * The extension an image media type is written as; `png` for an unknown or
 * absent type (what a browser clipboard carries for a screenshot).
 *
 * @param type - The media type (`image/svg+xml`, `image/jpeg`, ...).
 * @returns The extension without the dot.
 */
export function extensionForMediaType(type: string | undefined): string {
	const media = (type ?? '').toLowerCase();
	const found = Object.entries(IMAGE_MEDIA_TYPES).find(([, mediaType]) => mediaType === media);
	return found ? found[0] : 'png';
}

/**
 * The name a pasted image gets: `<docStem>-<n>.<ext>`, the extension from
 * the clipboard's media type so the bytes are labelled as what they are.
 *
 * @param docStem - The document's stem (the pipeline id or the app slug).
 * @param n - The 1-based paste ordinal.
 * @param type - The clipboard's media type; absent = PNG.
 * @returns The file name.
 */
export function pastedImageName(docStem: string, n: number, type?: string): string {
	return `${safeAssetName(docStem) || 'image'}-${n}.${extensionForMediaType(type)}`;
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

/**
 * Removes every live reference to one file from the README text: markdown
 * images and links whose destination names it (`![alt](ref)`, `[text](ref)`,
 * with or without a title, in any spelling of the path) and HTML `<img>`
 * tags whose `src` does. Code examples stay. A line left empty by the
 * removal is dropped so no blank hole remains. The file itself is untouched.
 *
 * @param markdown - The README text.
 * @param ref - The reference as the scanner lists it (see {@link IReadmeReference.ref}).
 * @returns The text without the reference.
 */
export function removeReference(markdown: string, ref: string): string {
	const admits = names(ref);
	// Step 1: reference-style: the definitions naming the file and every usage of their labels
	const labels = new Set(admittedDefinitions(markdown, admits).keys());
	const withoutDefinitions = rewriteReferenceUsages(rewriteDefinitions(markdown, labels, () => ''), labels, false, () => '');
	// Step 2: inline links, images and img tags
	const stripped = rewriteImageTags(rewriteMarkdownLinks(withoutDefinitions, admits, false, () => ''), admits, () => '');
	// Step 3: drop the lines the removal emptied (only those that held a reference)
	return dropEmptiedLines(markdown, stripped);
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
	// Step 1: one read per file, keyed by the canonical path so every spelling of it swaps
	const inlined = new Map<string, string>();
	for (const ref of scanReadmeReferences(markdown)) {
		if (!isImageName(ref)) continue;
		const uri = await resolve(ref).catch(() => null);
		if (uri) inlined.set(normalizePosixPath(ref), uri);
	}
	if (inlined.size === 0) return markdown;
	const admits: Admits = (dest) => inlined.has(canonicalRef(dest));
	const uriOf = (dest: string): string => inlined.get(canonicalRef(dest)) ?? dest;
	// Step 2: the swap, outside code, titles and other attributes kept — a
	// reference definition's destination swaps in place, its usages untouched
	const withDefinitions = rewriteDefinitions(markdown, new Set(admittedDefinitions(markdown, admits).keys()), (prefix, _label, dest, rest) => `${prefix}${uriOf(dest)}${rest}`);
	const withMarkdown = rewriteMarkdownLinks(withDefinitions, admits, true, (bang, alt, dest, title) => `${bang}[${alt}](${uriOf(dest)}${title})`);
	return rewriteImageTags(withMarkdown, admits, (attrs, src) => `<img${attrs.slice(0, src.valueStart)}${uriOf(src.value)}${attrs.slice(src.valueEnd)}>`);
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
// DOWNSCALE — raster images the pane writes fit inside 1024 x 800 (the math;
// the canvas work is `assetsDownscale`, browser-only)
// =============================================================================

/** The box every inserted raster image is scaled to fit (never upscaled). */
export const MAX_ASSET_WIDTH = 1024;
export const MAX_ASSET_HEIGHT = 800;

/**
 * The size an image takes inside the box: shrunk to fit with its aspect
 * kept, never grown. The pure math behind the pane's downscale.
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
