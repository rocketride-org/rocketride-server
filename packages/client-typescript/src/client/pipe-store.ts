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
// PIPE STORE BLOCK — the store listing of a pipeline (plan §9)
// =============================================================================
//
// A pipeline's store listing is a ROOT block `store` inside the `.pipe` JSON,
// beside `project_id`, `name`, `description` and `source` (never duplicated in
// the block). It mirrors an app's `appManifest` listing fields: tagline,
// categories, tags, icon, readme, links, mode and billing. Every pipeline
// carries the block: the scaffolds write it, and the packers and the deploy
// door add the default one to a pipe that has none. `icon` and `readme` are
// paths relative to the pipe file's directory, and the README's own
// image/link references name the files the pack carries beside it. `icon` is
// optional: a pipe without one leaves it unset and each UI shows its own
// fallback; a declared icon must be in the pack.
//
// PURE: no Node imports, so the browser (the store VFS, the editor) and the
// Node packer (`rocketride/app-pack`) share the one rule set. The Python twin
// is packages/client-python/src/rocketride/_pipe_bundle.py.
// =============================================================================

import { PLACEHOLDER_ICON_SVG } from '../app-scaffold/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * One billing plan of a listing's `billing.plans` — the Stripe-shaped pricing
 * proposal that rides every deploy (the packed manifest is the listing truth)
 * and goes live on store approval. Apps carry it in `appManifest.billing`,
 * pipelines in the `store.billing` block.
 */
export interface BillingPlan {
	/** Plan display name ("Starter", "Pro"). */
	nickname: string;
	/** Price in cents. */
	amountCents: number;
	/** ISO currency code. */
	currency: string;
	/** Billing interval ("month", "year", "one_time"). */
	interval: string;
	/**
	 * Opaque plan metadata (credits, seats, features, ordering, display
	 * overrides) — preserved verbatim on the save round-trip, never edited
	 * by the listing form.
	 */
	metadata?: Record<string, unknown>;
}

/** The eight keys a `store` block may carry, in the scaffold's order. */
export const STORE_KEYS = ['tagline', 'categories', 'tags', 'icon', 'readme', 'links', 'mode', 'billing', 'version'] as const;

/**
 * The pipeline's own version, as an app's is in package.json: major.minor.patch
 * with an optional pre-release tag. It is what a tile shows; the registry's
 * version NUMBER stays what a deploy or a pin names.
 */
export const STORE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** The monetization modes, the app model. */
export const STORE_MODES = ['free', 'subscription', 'paywall'] as const;

/** One key of the block. */
export type StoreKey = (typeof STORE_KEYS)[number];

/** One monetization mode. */
export type StoreMode = (typeof STORE_MODES)[number];

/** The `store` block of a `.pipe`: the pipeline's store listing. */
export interface PipeStoreBlock {
	/** The pipeline's own version (major.minor.patch), set by its author as an app's package version is. */
	version?: string;
	/** One-line tagline for the store card. */
	tagline?: string;
	/** Store categories. */
	categories?: string[];
	/** Free tags. */
	tags?: string[];
	/** Icon path, relative to the pipe file's directory. */
	icon?: string;
	/** README path (the store page), relative to the pipe file's directory. */
	readme?: string;
	/** Links the listing shows, label -> URL. */
	links?: Record<string, string>;
	/** Monetization mode. */
	mode?: StoreMode;
	/** Pricing plans (the app plan machinery). */
	billing?: { plans: BillingPlan[] };
}

// =============================================================================
// DEFAULTS
// =============================================================================

/**
 * The app scaffold's placeholder icon, for a pipeline that wants one. The
 * pipeline scaffold writes no icon file and the default block names none.
 */
export const PIPE_ICON_SVG = PLACEHOLDER_ICON_SVG;

/**
 * The block a new pipeline is stamped with — a fresh object each call. It
 * names no icon: a pipeline without one leaves `icon` unset.
 *
 * @returns The scaffold's default store block.
 */
export function defaultStoreBlock(): PipeStoreBlock {
	return {
		version: '1.0.0',
		tagline: '',
		categories: ['pipeline'],
		tags: [],
		readme: './README.md',
		links: {},
		mode: 'free',
		billing: { plans: [] },
	};
}

/**
 * The scaffolded starter README of a pipeline — the pipeline scaffold's twin
 * of the app scaffold's README: the store listing has a document to grow into.
 *
 * @param displayName - The pipeline's display name.
 * @returns The README.md file content.
 */
export function pipeReadmeStub(displayName: string): string {
	return `# ${displayName}\n\n${displayName} — a RocketRide pipeline.\n\n## What it does\n\nDescribe your pipeline here — this README ships with the pipeline and appears on its store listing.\n`;
}

// =============================================================================
// PATHS (posix, pure)
// =============================================================================

/** Narrows an unknown JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalises a posix path: separators unified, `.` segments dropped, `..`
 * folded into the segment before it. A `..` with nothing to fold stays, so
 * the caller can see an escape (`../x` stays `../x`).
 *
 * @param rel - The path, either separator.
 * @returns The normalised posix path ('' for an empty one).
 */
export function normalizePosixPath(rel: string): string {
	const out: string[] = [];
	for (const segment of rel.replace(/\\/g, '/').split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
		else out.push(segment);
	}
	return out.join('/');
}

/**
 * The posix directory of a path ('' for a bare file name).
 *
 * @param rel - The path, either separator.
 * @returns The directory part.
 */
function posixDirname(rel: string): string {
	const normalised = rel.replace(/\\/g, '/');
	const slash = normalised.lastIndexOf('/');
	return slash < 0 ? '' : normalised.slice(0, slash);
}

/**
 * Checks a declared icon/readme path by SPELLING, the server door's rule:
 * relative (no absolute path, no drive letter) and no `..` segment at all,
 * not even one that would fold inside the tree (`a/../icon.svg`) — the
 * server refuses the declaration as written, so the client refuses it
 * first. Containment on the real file system is the packer's check.
 *
 * @param key - The block key, for the error.
 * @param value - The declared value.
 * @returns The value, surrounding whitespace stripped (as the server reads it).
 * @throws Error naming the key when the path is not relative-and-inside.
 */
function checkRelativePath(key: StoreKey, value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`store.${key} must be a non-empty relative path`);
	const trimmed = value.trim();
	const posix = trimmed.replace(/\\/g, '/');
	if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) throw new Error(`store.${key} must be a path relative to the pipe file, not "${trimmed}"`);
	if (posix.split('/').includes('..')) throw new Error(`store.${key} must stay inside the pipe file's directory, not "${trimmed}"`);
	return trimmed;
}

// =============================================================================
// BILLING
// =============================================================================

/**
 * Coerces a plan price to cents. A missing value means "no price declared"
 * (0); a finite number or numeric string is accepted; anything else is an
 * error — a price must never be silently replaced with zero, because the
 * load→save round trip would persist it.
 *
 * @param value - The raw amountCents entry, straight from JSON.
 * @returns The price in cents.
 */
function normalizeAmountCents(value: unknown): number {
	if (value === undefined || value === null) return 0;
	const cents = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	if (!Number.isFinite(cents)) {
		throw new Error(`Invalid billing plan amountCents: ${JSON.stringify(value)}`);
	}
	return cents;
}

/**
 * Projects one raw plan into the typed shape — the Stripe fields coerced to
 * their contracted types, every OTHER key carried verbatim so the load→save
 * round trip never sheds content it does not understand.
 *
 * @param raw - One entry of `billing.plans`, straight from JSON.
 * @returns The typed plan.
 * @throws Error on a price that is not a number.
 */
export function normalizeBillingPlan(raw: unknown): BillingPlan {
	const source = isRecord(raw) ? raw : {};
	// step: metadata never rides the verbatim spread — a non-record value
	// (string, array) would violate BillingPlan; it re-enters only validated
	const { metadata, ...rest } = source;
	return {
		...rest,
		nickname: typeof source.nickname === 'string' ? source.nickname : '',
		amountCents: normalizeAmountCents(source.amountCents),
		currency: typeof source.currency === 'string' ? source.currency : 'usd',
		interval: typeof source.interval === 'string' ? source.interval : 'month',
		...(isRecord(metadata) ? { metadata } : {}),
	};
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Checks a `store` block and returns it typed, plans normalised.
 *
 * @param store - The block as read from the `.pipe` JSON.
 * @returns The validated block.
 * @throws Error naming the offending key or value: not an object, an unknown
 *   key, a non-string tagline, a non-string-list categories/tags, a bad
 *   icon/readme path, non-string links, an unknown mode, or malformed billing.
 */
export function validateStoreBlock(store: unknown): PipeStoreBlock {
	if (!isRecord(store)) throw new Error('store must be a JSON object');
	// step: the key set is closed — a typo never rides silently
	const allowed = new Set<string>(STORE_KEYS);
	for (const key of Object.keys(store)) {
		if (!allowed.has(key)) throw new Error(`store: unknown key "${key}" (allowed: ${STORE_KEYS.join(', ')})`);
	}
	const out: PipeStoreBlock = {};
	if (store.tagline !== undefined) {
		if (typeof store.tagline !== 'string') throw new Error('store.tagline must be a string');
		out.tagline = store.tagline;
	}
	if (store.version !== undefined) {
		if (typeof store.version !== 'string' || !STORE_VERSION_PATTERN.test(store.version)) throw new Error('store.version must be a version such as 1.0.0 (major.minor.patch)');
		out.version = store.version;
	}
	for (const key of ['categories', 'tags'] as const) {
		const list = store[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) throw new Error(`store.${key} must be a list of strings`);
		out[key] = [...(list as string[])];
	}
	if (store.icon !== undefined) out.icon = checkRelativePath('icon', store.icon);
	if (store.readme !== undefined) out.readme = checkRelativePath('readme', store.readme);
	if (store.links !== undefined) {
		if (!isRecord(store.links) || Object.values(store.links).some((url) => typeof url !== 'string')) throw new Error('store.links must map labels to URL strings');
		out.links = { ...(store.links as Record<string, string>) };
	}
	if (store.mode !== undefined) {
		// step: a string, then one of the modes — `String(['free'])` would read as 'free'
		if (typeof store.mode !== 'string' || !(STORE_MODES as readonly string[]).includes(store.mode)) throw new Error(`store.mode must be ${STORE_MODES.join(', ')}, not ${JSON.stringify(store.mode)}`);
		out.mode = store.mode as StoreMode;
	}
	if (store.billing !== undefined) {
		if (!isRecord(store.billing) || !Array.isArray(store.billing.plans)) throw new Error('store.billing must be { plans: [...] }');
		// step: the raw shape is the server door's — an extra billing key or a
		// plan that is not an object is refused here, never normalised away
		const unknown = Object.keys(store.billing).filter((key) => key !== 'plans');
		if (unknown.length > 0) throw new Error(`store.billing: unknown key "${unknown[0]}" (allowed: plans)`);
		if (store.billing.plans.some((plan) => !isRecord(plan))) throw new Error('store.billing.plans must be a list of plan objects');
		out.billing = { plans: store.billing.plans.map(normalizeBillingPlan) };
	}
	return out;
}

// =============================================================================
// README REFERENCES
// =============================================================================

/**
 * A markdown image or link: `![alt](path)` / `[text](path)`, optional title.
 * The destination is angle-delimited (`<a b.png>`, spaces allowed; group 1)
 * or bare (group 2), where it may hold one level of balanced parentheses
 * (`plot(1).png`), as CommonMark allows.
 */
const MARKDOWN_REF_RE = /!?\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|((?:[^\s()<>]|\([^\s()]*\))+))(?:\s+["'][^"']*["'])?\s*\)/g;

/**
 * A markdown reference definition: `[label]: path` at the start of a line,
 * the destination of a reference-style image or link (`![alt][label]`);
 * angle-delimited (group 1, spaces allowed) or bare (group 2).
 */
const MARKDOWN_DEF_RE = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:<([^<>\n]*)>|([^\s<>]+))/gm;

/** An HTML `<img>` tag (the tag name case-insensitive); group 1 = its attribute text. */
const HTML_IMG_RE = /<img\b([^>]*)>/gi;

/**
 * One attribute token in a tag's attribute text: the name, then optionally
 * `=` and a double-quoted, single-quoted or bare value (the Assets pane's
 * rule, mirrored: a `src=` inside another attribute's VALUE is never a
 * token of its own).
 */
const ATTRIBUTE_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** A character reference in an attribute value: hex numeric, decimal numeric or named; groups 2-4. */
const CHARACTER_REFERENCE_RE = /&(#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi;

/** The named character references an attribute value carries (the ones the Assets pane writes, plus `&apos;`). */
const NAMED_CHARACTER_REFERENCES: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };

/**
 * Decodes the character references in an HTML attribute value, as the
 * browser reads it: `&amp;`, `&quot;`, `&#39;`, `&#x27;`, ... An unknown
 * reference stays as written. Markdown destinations are NOT decoded here;
 * only HTML attributes carry character references in this scanner.
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

/**
 * The `src` an `<img>` tag names: its first `src` attribute (the one the
 * browser keeps when it repeats), read by tokenizing the attributes in order,
 * its character references decoded (`a&amp;b.png` names `a&b.png`).
 *
 * @param attrs - The tag's attribute text.
 * @returns The source as the browser reads it, or '' when the tag has none.
 */
function imgSrcOf(attrs: string): string {
	for (const match of attrs.matchAll(ATTRIBUTE_RE)) {
		if (match[1].toLowerCase() === 'src') return decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '');
	}
	return '';
}

/** Fenced code blocks (backtick or tilde fences) and inline code spans — never references. */
const CODE_RE = /(```|~~~)[\s\S]*?\1|`[^`\n]*`/g;

/**
 * Whether a reference names a local file: not a URL scheme (`http:`,
 * `data:`, `mailto:` ...), not protocol-relative, not a bare anchor.
 *
 * @param ref - The raw reference text.
 * @returns True for a relative file reference.
 */
function isLocalReference(ref: string): boolean {
	if (ref === '' || ref.startsWith('#') || ref.startsWith('//')) return false;
	return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref);
}

/**
 * The relative files a README references: markdown images and links and
 * HTML `<img src>`, in order of appearance, de-duplicated, percent-decoded,
 * with any query string or fragment stripped. URLs (`http(s)://`, `data:`,
 * `mailto:` and every other scheme), protocol-relative refs and `#anchors`
 * are skipped, as is anything inside code.
 *
 * @param markdown - The README text.
 * @returns The references, relative to the README.
 */
export function scanReadmeReferences(markdown: string): string[] {
	const text = markdown.replace(CODE_RE, '');
	const seen = new Set<string>();
	const refs: string[] = [];
	const take = (raw: string): void => {
		if (!isLocalReference(raw)) return;
		// step: a fragment or query never names a file
		let ref = raw.split('#')[0].split('?')[0];
		try {
			ref = decodeURIComponent(ref);
		} catch {
			// a stray percent sign is a file name, not an encoding
		}
		if (ref === '' || seen.has(ref)) return;
		seen.add(ref);
		refs.push(ref);
	};
	// step: both syntaxes, each in document order; links and images first
	// (the common case), then HTML images
	const found: Array<{ index: number; ref: string }> = [];
	for (const match of text.matchAll(MARKDOWN_REF_RE)) found.push({ index: match.index ?? 0, ref: match[1] ?? match[2] ?? '' });
	for (const match of text.matchAll(MARKDOWN_DEF_RE)) found.push({ index: match.index ?? 0, ref: match[1] ?? match[2] ?? '' });
	for (const match of text.matchAll(HTML_IMG_RE)) found.push({ index: match.index ?? 0, ref: imgSrcOf(match[1]) });
	found.sort((a, b) => a.index - b.index);
	for (const { ref } of found) take(ref);
	return refs;
}

/**
 * The files a pipeline's store listing names, as posix paths relative to the
 * PIPE's directory: the declared readme and icon, and every file the README
 * references (resolved against the README's own directory). Paths are
 * normalised; a reference that escapes upward keeps its leading `..` so the
 * packer can refuse it by name.
 *
 * @param store - The validated block (null = no listing).
 * @param readmeText - The README content (null = none read).
 * @param readmePath - The README path relative to the pipe's directory.
 * @returns `declared` ([readme, icon] that are set) and `referenced`.
 */
export function pipeStoreFiles(store: PipeStoreBlock | null, readmeText: string | null, readmePath: string | null): { declared: string[]; referenced: string[] } {
	const declared: string[] = [];
	if (store?.readme) declared.push(normalizePosixPath(store.readme));
	if (store?.icon) declared.push(normalizePosixPath(store.icon));
	const referenced: string[] = [];
	if (readmeText !== null && readmePath !== null) {
		const base = posixDirname(normalizePosixPath(readmePath));
		for (const ref of scanReadmeReferences(readmeText)) {
			const resolved = normalizePosixPath(base ? `${base}/${ref}` : ref);
			if (resolved !== '' && !referenced.includes(resolved)) referenced.push(resolved);
		}
	}
	return { declared, referenced };
}
