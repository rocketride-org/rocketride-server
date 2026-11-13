// =============================================================================
// SANITIZE - the before_send hook's pure core, and the reductions applied where
// posthog-js stores or records an address without passing before_send.
//
// Every URL that leaves the browser keeps only its utm_* query parameters and
// no fragment; every referrer is reduced to scheme + host; ad click ids are
// removed wherever posthog-js stores them. No DOM, no imports: unit-tested
// under node:test (test/unit/sanitize.test.ts). Fails closed: an event the
// sanitizer cannot process is dropped, never sent as it was.
// =============================================================================

/** Ad-network click identifiers posthog-js records as campaign properties. */
export const CLICK_ID_KEYS: string[] = [
	'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'twclid',
	'li_fat_id', 'mc_cid', 'igshid', 'ttclid', 'rdt_cid', 'epik', 'qclid', 'sccid',
	'irclid', '_kx',
	// Not a per-click id, but a Google Ads parameter posthog-js also registers from the URL: dropped with the rest.
	'gad_source',
];

/**
 * Values posthog-js derives from a click id or a referrer's query: Meta's click and browser ids ($fbc from
 * fbclid or the _fbc cookie, $fbp from the _fbp cookie) and a search engine's query (ph_keyword). Dropped like
 * the click ids they come from; $search_engine (the referrer's host) stays.
 */
export const DERIVED_ID_KEYS: string[] = ['$fbc', '$fbp', 'ph_keyword'];

/** Where posthog-js keeps Meta's click and browser ids between events (in its cookie): never stored. */
export const STORED_DERIVED_ID_KEYS: string[] = ['$fbc_persistence', '$fbp_persistence'];

const CLICK_ID_SET = new Set([...CLICK_ID_KEYS, ...DERIVED_ID_KEYS]);

/** Keep scheme, host and path; keep only utm_* query params; drop the fragment and any user:password. */
export function sanitizeUrl(url: string): string {
	if (typeof url !== 'string' || url === '') return '';
	let u: URL;
	try { u = new URL(url); } catch { return ''; }
	const kept = new URLSearchParams();
	u.searchParams.forEach((value, key) => { if (key.startsWith('utm_')) kept.append(key, value); });
	u.search = '';
	u.hash = '';
	u.username = '';
	u.password = '';
	const query = kept.toString();
	return u.toString() + (query ? '?' + query : '');
}

/** A query string (without its '?') reduced to its utm_* parameters. */
function keepUtm(query: string): string {
	const kept = new URLSearchParams();
	new URLSearchParams(query).forEach((value, key) => {
		if (key.startsWith('utm_')) {
			kept.append(key, value);
		}
	});
	return kept.toString();
}

/**
 * Hosts whose static asset addresses keep their query inside recordings: public font stylesheets, whose query
 * names the font families (the recording player needs it), never visitor data.
 */
const STATIC_QUERY_HOSTS = new Set(['fonts.googleapis.com']);

/**
 * Any address an element carries, in any form: absolute and protocol-relative URLs keep only utm_* (as
 * sanitizeUrl); a relative address keeps its path and its utm_* parameters; another scheme (mailto:, tel:)
 * loses everything from its '?' or '#'. A fragment is kept only when it is a plain in-page anchor (no '='),
 * since a fragment with parameters can carry a token. data: URIs (inline images) are page content and stay.
 *
 * @param value - The address as the element carries it; any other type is not an address.
 * @returns The reduced address; '' for a value that is not a string, is blank, or is an absolute URL that cannot be parsed.
 */
export function reduceHref(value: unknown): string {
	if (typeof value !== 'string') {
		return '';
	}
	const v = value.trim();
	if (v === '') {
		return '';
	}
	if (/^https?:\/\//i.test(v)) {
		let host = '';
		try { host = new URL(v).hostname; } catch { return ''; }
		if (STATIC_QUERY_HOSTS.has(host)) {
			return v;
		}
		return sanitizeUrl(v);
	}
	if (v.startsWith('//')) {
		return reduceHref('https:' + v).replace(/^https:/, '');
	}
	if (/^data:/i.test(v)) {
		return v;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
		const cut = v.search(/[?#]/);
		if (cut === -1) {
			return v;
		}
		return v.slice(0, cut);
	}
	const hashAt = v.indexOf('#');
	let fragment = '';
	let base = v;
	if (hashAt !== -1) {
		fragment = v.slice(hashAt);
		base = v.slice(0, hashAt);
	}
	const queryAt = base.indexOf('?');
	let path = base;
	let query = '';
	if (queryAt !== -1) {
		path = base.slice(0, queryAt);
		query = keepUtm(base.slice(queryAt + 1));
	}
	let anchor = '';
	if (fragment && !fragment.includes('=')) {
		anchor = fragment;
	}
	if (query) {
		return path + '?' + query + anchor;
	}
	return path + anchor;
}

/**
 * A srcset ("a.png 1x, b.png?w=2 2x"): every address in it reduced, the descriptors kept.
 *
 * @param value - The srcset attribute's value.
 * @returns The srcset with every address reduced; '' for a value that is not a string.
 */
export function reduceSrcset(value: string): string {
	if (typeof value !== 'string') {
		return '';
	}
	return value.split(',').map((part) => {
		const [address, ...descriptors] = part.trim().split(/\s+/);
		return [reduceHref(address ?? ''), ...descriptors].filter((s) => {
			return s !== '';
		}).join(' ');
	}).join(', ');
}

/**
 * Every url(...) in CSS text reduced like any address.
 *
 * @param css - The CSS text (an inline style, or a stylesheet's text).
 * @returns The CSS text with the address in every url(...) reduced.
 */
export function reduceCssUrls(css: string): string {
	return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, q: string, address: string) => {
		return `url(${q}${reduceHref(address)}${q})`;
	});
}

/** A full address, or a rooted relative one carrying a query or a fragment ("/r?token=...", "/cb#k=v"). */
function looksLikeAddress(value: string): boolean {
	return /^\s*(https?:)?\/\//i.test(value) || /^\s*\/[^\s]*[?#]/.test(value);
}

/**
 * An unrooted relative address whose query or fragment carries a parameter ("account?code=...", "cb#token=...").
 * A parameter (an '=') is required, so plain text that merely ends in '?' ("Ready?") is not taken for one.
 */
function looksLikeRelativeAddress(value: string): boolean {
	return /^\s*[^\s?#]*[?#][^\s]*=/.test(value);
}

/**
 * A string property value that is an address, reduced: an absolute one keeps only utm_* (sanitizeUrl), a
 * protocol-relative, rooted relative or unrooted relative one ("account?code=...") is reduced like an
 * element's address (reduceHref).
 *
 * @param value - The property value.
 * @returns The reduced address, or null when the value is not an address.
 */
function reducePropertyAddress(value: string): string | null {
	if (/^\s*https?:\/\//i.test(value)) {
		return sanitizeUrl(value.trim());
	}
	if (looksLikeAddress(value) || looksLikeRelativeAddress(value)) {
		return reduceHref(value);
	}
	return null;
}

/** Element attributes whose value is an address. */
const ADDRESS_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'cite', 'background', 'ping', 'longdesc', 'manifest', 'codebase', 'archive']);

/**
 * The recorder's attribute hook (session_recording.maskAttributeFn), for full snapshots and attribute
 * mutations alike: every address in an element's attributes is reduced before it enters a recording (a link
 * or image could otherwise carry a token or the landing query). Fails closed: an attribute it cannot process
 * is recorded empty.
 *
 * @param name - The attribute's name.
 * @param value - The attribute's value.
 * @returns The value with every address in it reduced; '' for a value it cannot process.
 */
export function maskReplayAttribute(name: string, value: string): string {
	try {
		if (typeof value !== 'string' || value === '') {
			return value;
		}
		let n = '';
		if (typeof name === 'string') {
			n = name.toLowerCase();
		}
		if (ADDRESS_ATTRIBUTES.has(n)) {
			return reduceHref(value);
		}
		if (n === 'srcset' || n === 'imagesrcset') {
			return reduceSrcset(value);
		}
		// Inline styles, and the stylesheet text the recorder copies into `_cssText` (where it has already resolved
		// relative url()s against the page address, query included).
		if ((n === 'style' || n === '_csstext') && /url\(/i.test(value)) {
			return reduceCssUrls(value);
		}
		// <meta http-equiv="refresh" content="0;url=...">
		if (n === 'content' && /^\s*\d+\s*;\s*url\s*=/i.test(value)) {
			return value.replace(/(url\s*=\s*)(['"]?)([^'"]*)\2/i, (_m, pre: string, q: string, address: string) => {
				return `${pre}${q}${reduceHref(address)}${q}`;
			});
		}
		// Any other attribute holding a full address (og:url in a meta tag's content, a data-* attribute), or a
		// relative one (rooted or not) with a query or a fragment.
		if (looksLikeAddress(value) || looksLikeRelativeAddress(value)) {
			return reduceHref(value);
		}
		return value;
	} catch {
		return '';
	}
}

/**
 * The recorder's network hook (session_recording.maskCapturedNetworkRequestFn). posthog-js passes every network
 * request a recording would include through it, and also every page address it writes into a recording (the
 * Meta event, $url_changed) as { name: url }; neither passes before_send. The address keeps only utm_*; the
 * request and response headers, bodies and server timings are removed whatever the project's settings say.
 * Fails closed: for a request it cannot process it returns null, and posthog-js records no address or content of it.
 *
 * @param req - The recorded request, or a page address as { name: url }.
 * @returns A copy with its address reduced and its headers, bodies and server timings removed; null for a request
 * it cannot process.
 */
export function reduceRecordedRequest<T extends { name?: unknown }>(req: T): T | null {
	try {
		if (!req || typeof req !== 'object') {
			return req;
		}
		const out: Record<string, unknown> = { ...(req as Record<string, unknown>) };
		for (const key of ['requestHeaders', 'responseHeaders', 'requestBody', 'responseBody', 'serverTimings']) {
			delete out[key];
		}
		if (typeof out.name === 'string') {
			out.name = sanitizeUrl(out.name);
		}
		return out as T;
	} catch {
		return null; // fails closed: posthog-js leaves a request its mask returns null for out of the recording
	}
}

/** Reduce a referrer to its origin. '$direct' passes through; anything unparsable becomes ''. */
export function referrerOrigin(ref: string): string {
	if (typeof ref !== 'string' || ref === '') return '';
	if (ref === '$direct') return '$direct';
	try {
		const u = new URL(ref);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
		return u.origin;
	} catch { return ''; }
}

/**
 * Free text that may hold addresses (an exception's message, a stack frame): absolute URLs keep only utm_*
 * (an unparsable one becomes '[url]'), other schemes lose their query and fragment, and any remaining query
 * (a relative URL in the text) keeps only utm_*; a fragment holding parameters is removed.
 *
 * @param text - The free text.
 * @returns The text with every address in it reduced; a value that is not a string, or is empty, as it was.
 */
export function reduceUrlsInText(text: string): string {
	if (typeof text !== 'string' || text === '') {
		return text;
	}
	return text
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()`]+/gi, (m) => {
			if (/^https?:/i.test(m)) {
				return sanitizeUrl(m) || '[url]';
			}
			return m.replace(/[?#].*$/, '');
		})
		.replace(/\?([^\s"'<>()`#]*=[^\s"'<>()`#]*)/g, (_m, query: string) => {
			const kept = keepUtm(query);
			if (kept) {
				return '?' + kept;
			}
			return '';
		})
		.replace(/#[^\s"'<>()`]*=[^\s"'<>()`]*/g, '');
}

function isClickIdKey(key: string): boolean {
	if (CLICK_ID_SET.has(key)) {
		return true;
	}
	for (const prefix of ['$initial_', '$session_entry_']) {
		if (key.startsWith(prefix) && CLICK_ID_SET.has(key.slice(prefix.length))) {
			return true;
		}
	}
	return false;
}

/** How deep a nested object inside an event property is walked; one nested deeper is removed. */
const NESTED_MAX_DEPTH = 4;

function scrub(bag: Record<string, unknown>, depth = 0): void {
	for (const key of Object.keys(bag)) {
		let value = bag[key];
		if (isClickIdKey(key)) { delete bag[key]; continue; }
		// An object with custom serialization (a URL instance, a Date) is sent as what its toJSON() returns,
		// never as its enumerable fields, so that representation is what gets reduced.
		if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
			value = (value as { toJSON: () => unknown }).toJSON();
			bag[key] = value;
		}
		// Every `*_url` property of every event, cookieless ones included, keeps only its utm_* parameters:
		// `$current_url`, `$initial_current_url`, and the session-entry properties a persistent
		// instance adds to every event, `$session_entry_url` and `$session_entry_referrer`.
		if (key.endsWith('_url') && typeof value === 'string') { bag[key] = sanitizeUrl(value); continue; }
		if (key.endsWith('referrer') && typeof value === 'string') { bag[key] = referrerOrigin(value); continue; }
		// Any other property holding an address, whatever its key: an app's reporter takes free-form properties,
		// so `{ url: 'https://.../cb?code=...' }` must lose its query like `$current_url` does. The clicked
		// element's chain is a string with its own grammar (`attr__href="/cb?code=..."nth-child="1"`), reduced
		// value by value in scrubElementsChain, never as one address.
		if (typeof value === 'string' && key !== '$elements_chain') {
			const address = reducePropertyAddress(value);
			if (address !== null) { bag[key] = address; continue; }
		}
		// A nested object or array (an app's free-form `detail`, the SDK's `$set`/`$set_once`) is reduced by the
		// same rules one level down; one nested past NESTED_MAX_DEPTH is removed, never sent unreduced.
		if (value && typeof value === 'object') {
			if (depth > NESTED_MAX_DEPTH) { delete bag[key]; continue; }
			scrub(value as Record<string, unknown>, depth + 1);
		}
	}
}

/** posthog-js's stored first-visit and session-entry info: `u` the page address, `r` the referrer. */
function reduceVisitInfo(info: unknown): unknown {
	if (!info || typeof info !== 'object') {
		return info;
	}
	const out: Record<string, unknown> = { ...(info as Record<string, unknown>) };
	if (typeof out.u === 'string') {
		out.u = sanitizeUrl(out.u) || undefined;
	}
	// '$direct' (no referrer) stays as it is
	if (typeof out.r === 'string' && out.r !== '$direct') {
		out.r = referrerOrigin(out.r);
	}
	return out;
}

/** Keys posthog-js stores that hold a visit's address and referrer: `$initial_person_info` {u, r} and `$client_session_props` {sessionId, props: {u, r}}. */
const STORED_VISIT_KEYS = new Set(['$initial_person_info', '$client_session_props']);

/**
 * Keys posthog-js stores that hold a bag of person or group properties, which it sends to /flags: the `$set` of an
 * identified visitor's capture lands in `$stored_person_properties` before before_send runs (it can carry the
 * Meta click id posthog-js derives from an fbclid), so each bag is reduced with the same rules, all the way down.
 */
const STORED_PROPERTY_BAGS = new Set(['$stored_person_properties', '$stored_group_properties']);

/** How deep a stored property bag is reduced; a value nested deeper is not stored, never stored unread. */
const STORED_BAG_MAX_DEPTH = 4;

/**
 * What posthog-js may write to its storage (its cookie, localStorage, sessionStorage), reduced first: the stored
 * first-visit and session-entry addresses keep only utm_*, referrers keep only their origin, click ids and the
 * Meta ids derived from them are not stored. These values feed the /flags request and the person properties,
 * neither of which passes before_send, so they are reduced where they are stored. Pure; returns a new object.
 * Fails closed per key: a value it cannot reduce is not stored.
 *
 * @param props - What posthog-js is about to store.
 * @returns The properties to store instead.
 */
export function reduceStoredProps(props: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(props)) {
		if (isClickIdKey(key) || STORED_DERIVED_ID_KEYS.includes(key)) {
			continue;
		}
		const reduced = reduceStoredEntry(props, key);
		if (reduced !== NOT_STORED) {
			out[key] = reduced;
		}
	}
	return out;
}

/** What reduceStoredEntry returns for a value it cannot reduce: the key is not stored. */
const NOT_STORED = Symbol('not stored');

/**
 * One stored property, reduced by its kind: a property bag, a visit record, or a single value.
 *
 * @param props - The properties being stored.
 * @param key - The property to reduce.
 * @returns The reduced value, or NOT_STORED when it cannot be reduced (fail closed).
 */
function reduceStoredEntry(props: Record<string, unknown>, key: string): unknown {
	try {
		const value = props[key];
		if (STORED_PROPERTY_BAGS.has(key) && isBag(value)) {
			return reduceStoredBag(key, value);
		}
		if (STORED_VISIT_KEYS.has(key)) {
			return reduceStoredVisit(key, value);
		}
		return reduceStoredValue(key, value);
	} catch {
		return NOT_STORED;
	}
}

/** A plain object, the shape of every property bag posthog-js stores (not an array, not null). */
function isBag(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A stored property bag, reduced: person properties are one bag, group properties one bag per group type. Every
 * level is reduced (a group's `metadata: { callback_url }` included), down to STORED_BAG_MAX_DEPTH.
 *
 * @param key - `$stored_person_properties` or `$stored_group_properties`.
 * @param bag - Its value.
 * @returns The bag with every property reduced.
 */
function reduceStoredBag(key: string, bag: Record<string, unknown>): Record<string, unknown> {
	if (key === '$stored_group_properties') {
		// One level more: the group type, then that group's properties.
		return reduceBagProps(bag, -1);
	}
	return reduceBagProps(bag, 0);
}

/**
 * One level of a stored property bag: click ids and Meta ids dropped, every other value reduced (reduceBagValue).
 *
 * @param bag - The properties at this level.
 * @param depth - How deep this level sits below the bag.
 * @returns The reduced properties; a value that cannot be reduced is left out (fail closed).
 */
function reduceBagProps(bag: Record<string, unknown>, depth: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(bag)) {
		if (isClickIdKey(key) || STORED_DERIVED_ID_KEYS.includes(key)) {
			continue;
		}
		let reduced: unknown;
		try {
			reduced = reduceBagValue(key, value, depth);
		} catch {
			continue;
		}
		if (reduced !== NOT_STORED) {
			out[key] = reduced;
		}
	}
	return out;
}

/**
 * One value inside a stored property bag: a nested object or array is reduced one level down (past
 * STORED_BAG_MAX_DEPTH it is not stored); a *_url or *referrer string by its key's rules (reduceStoredValue), and
 * any other string that is an address loses its query whatever its key.
 *
 * @param key - The value's key.
 * @param value - The value.
 * @param depth - How deep the value's holder sits below the bag.
 * @returns The reduced value, or NOT_STORED.
 */
function reduceBagValue(key: string, value: unknown, depth: number): unknown {
	if (value && typeof value === 'object') {
		if (depth + 1 >= STORED_BAG_MAX_DEPTH) {
			return NOT_STORED;
		}
		if (Array.isArray(value)) {
			return value.map((item) => {
				return reduceBagValue(key, item, depth + 1);
			}).filter((item) => {
				return item !== NOT_STORED;
			});
		}
		return reduceBagProps(value as Record<string, unknown>, depth + 1);
	}
	// An address under a key without its own rule (not *_url, not *referrer) loses its query too.
	if (typeof value === 'string' && !key.endsWith('_url') && !key.endsWith('referrer')) {
		return reducePropertyAddress(value) ?? value;
	}
	return reduceStoredValue(key, value);
}

/**
 * A stored visit record: `$client_session_props` keeps its session id, with its visit info reduced; the other
 * visit keys are visit info themselves.
 *
 * @param key - One of STORED_VISIT_KEYS.
 * @param value - Its value.
 * @returns The value with its address and referrer reduced.
 */
function reduceStoredVisit(key: string, value: unknown): unknown {
	if (key === '$client_session_props' && isBag(value) && 'props' in value) {
		return { ...value, props: reduceVisitInfo(value.props) };
	}
	return reduceVisitInfo(value);
}

/**
 * Any other stored value: an address keeps its utm_* parameters only, a referrer its origin.
 *
 * @param key - The stored key.
 * @param value - Its value.
 * @returns The value as it may be stored.
 */
function reduceStoredValue(key: string, value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	if (key.endsWith('_url')) {
		return sanitizeUrl(value);
	}
	if (key.endsWith('referrer') && value !== '$direct') {
		return referrerOrigin(value);
	}
	return value;
}

/** The shape before_send receives: the parts of posthog-js's CaptureResult this file reads, kept import-free. */
export interface CaptureLike {
	event?: string;
	properties?: Record<string, unknown> | null;
	$set?: Record<string, unknown>;
	$set_once?: Record<string, unknown>;
}


/**
 * Web vitals carry nested objects (`$web_vitals_LCP_event` and the like) whose
 * `navigationURL`, `$current_url` and attribution `url` are full URLs: every
 * string inside them that is a URL is reduced the same way as the top level.
 * An object nested past NESTED_MAX_DEPTH is removed, so no URL below the cap
 * leaves the browser unreduced.
 */
function scrubNestedUrls(value: unknown, depth = 0): void {
	if (!value || typeof value !== 'object') {
		return;
	}
	const obj = value as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		scrubNestedValue(obj, key, depth);
	}
}

/**
 * One value of a nested web vitals object: a URL is reduced, an object is scrubbed one level down, and an object
 * past NESTED_MAX_DEPTH is removed.
 *
 * @param obj - The object holding the value.
 * @param key - The value's key.
 * @param depth - How deep `obj` sits below the event property.
 */
function scrubNestedValue(obj: Record<string, unknown>, key: string, depth: number): void {
	const v = obj[key];
	if (typeof v === 'string') {
		if (/^https?:\/\//i.test(v)) {
			obj[key] = sanitizeUrl(v);
		}
		return;
	}
	if (!v || typeof v !== 'object') {
		return;
	}
	if (depth >= NESTED_MAX_DEPTH) {
		delete obj[key];
		return;
	}
	scrubNestedUrls(v, depth + 1);
}

/**
 * The web vitals events posthog-js attaches to a `$web_vitals` capture (`$web_vitals_LCP_event` and the like),
 * reduced like the top level.
 *
 * @param props - The event's properties.
 */
function scrubWebVitalsEvents(props: Record<string, unknown>): void {
	for (const key of Object.keys(props)) {
		if (key.startsWith('$web_vitals_') && key.endsWith('_event')) {
			scrubNestedUrls(props[key]);
		}
	}
}

/**
 * Personal values free text can carry beyond addresses: email addresses, JSON web tokens and bearer credentials are
 * replaced by a label (an exception message or a serialized rejection value can quote them).
 *
 * @param text - The free text.
 * @returns The text with every email address, JSON web token and bearer or basic credential replaced by a label; a
 * value that is not a string, or is empty, as it was.
 */
export function redactSecretsInText(text: string): string {
	if (typeof text !== 'string' || text === '') {
		return text;
	}
	return text
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
		.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[token]')
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [token]');
}

/**
 * Free text (an exception message, a stack frame, an element's text or title): every address in it reduced, every
 * email and token redacted.
 *
 * @param text - The free text.
 * @returns The text with its addresses reduced and its emails and tokens replaced by a label.
 */
function reduceFreeText(text: string): string {
	return redactSecretsInText(reduceUrlsInText(text));
}

/** Every string inside an exception report (messages, serialized rejection values, stack frames): addresses reduced, emails and tokens redacted. */
function scrubText(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		return reduceFreeText(value);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	if (depth > 8) {
		if (Array.isArray(value)) {
			return [];
		}
		return {};
	}
	if (Array.isArray(value)) {
		return value.map((v) => {
			return scrubText(v, depth + 1);
		});
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = scrubText(v, depth + 1);
	}
	return out;
}

/** An exception report: every $exception* property reduced (the list of errors with their frames, the message). */
function scrubException(props: Record<string, unknown>): void {
	for (const key of Object.keys(props)) {
		if (key.startsWith('$exception')) {
			props[key] = scrubText(props[key]);
		}
	}
}

/** Heatmap batches are keyed by the page URL: the keys are reduced like any URL; a key that is not an http(s) URL is dropped. */
function scrubHeatmapData(props: Record<string, unknown>): void {
	const data = props.$heatmap_data;
	if (!data || typeof data !== 'object') {
		return;
	}
	const out: Record<string, unknown> = {};
	for (const [url, points] of Object.entries(data as Record<string, unknown>)) {
		if (!/^https?:\/\//i.test(url)) {
			continue;
		}
		const clean = sanitizeUrl(url);
		if (!clean) {
			continue;
		}
		const existing = out[clean];
		if (Array.isArray(existing) && Array.isArray(points)) {
			out[clean] = existing.concat(points);
		} else {
			out[clean] = points;
		}
	}
	props.$heatmap_data = out;
}

/**
 * Autocapture and dead-click payloads describe the clicked element chain. An
 * element marked data-rr-private (or any ancestor so marked) keeps no text and
 * no attributes; every address an element carries (its href, absolute or
 * relative, and any attribute holding a URL) is reduced, and its text and other
 * attributes are reduced as free text.
 */
function scrubElements(props: Record<string, unknown>): void {
	scrubElementsChain(props);
	if (typeof props.$el_text === 'string') {
		props.$el_text = reduceFreeText(props.$el_text);
	}
	const elements = props.$elements;
	if (!Array.isArray(elements)) {
		return;
	}
	const privateChain = elements.some((el) => {
		return el && typeof el === 'object' && 'attr__data-rr-private' in (el as Record<string, unknown>);
	});
	for (const el of elements) {
		if (el && typeof el === 'object') {
			scrubElement(el as Record<string, unknown>, privateChain);
		}
	}
	if (privateChain) {
		delete props.$el_text;
		delete props.$elements_chain;
	}
}

/**
 * One element of a clicked element's chain, in place: in a private chain it keeps no text and no attributes;
 * otherwise its text, its href and every attribute are reduced (reduceElementValue).
 *
 * @param e - The element's properties.
 * @param privateChain - Whether an element of the chain is marked data-rr-private.
 */
function scrubElement(e: Record<string, unknown>, privateChain: boolean): void {
	for (const key of Object.keys(e)) {
		const v = e[key];
		const isDescriptive = key === '$el_text' || key === 'text' || key.startsWith('attr__');
		if (privateChain && isDescriptive) {
			delete e[key];
		} else if (typeof v === 'string' && (isDescriptive || key === 'href')) {
			e[key] = reduceElementValue(key, v);
		}
	}
}

/**
 * One value an element carries: its href, or any value that is an address, keeps only utm_* (reduceHref); any
 * other value (the element's text, a title, a label) is reduced as free text, like an exception message.
 *
 * @param key - The value's key (`href`, `attr__href`, `text`, `$el_text`, `attr__title`, ...).
 * @param value - The value, unescaped.
 * @returns The reduced value.
 */
function reduceElementValue(key: string, value: string): string {
	if (key === 'href' || key === 'attr__href' || looksLikeAddress(value)) {
		return reduceHref(value);
	}
	return reduceFreeText(value);
}

/**
 * A value in an element chain. posthog-js writes a quote inside a value as `\"` and leaves a backslash as it is, so
 * `\\` is not an escape: a value runs to the first quote with no backslash before it. The closing quote is left for
 * the next match (`attr__href="..."href="..."` share it): a lookahead, not a group.
 */
const CHAIN_VALUE = /([:"])((?:attr__[A-Za-z0-9_:.-]+|attr_id|href|text)=")((?:\\"|[^"])*)(?=")/g;

/**
 * The production shape: the project's remote config sets elementsChainAsString,
 * so the SDK sends only `$elements_chain`, one string per element joined by ';'
 * (`tag.class:attr__x="v"href="..."text="..."`). A private chain is dropped
 * whole with `$el_text`; otherwise every value in it is reduced
 * (reduceElementValue). A chain that cannot be read value by value is dropped.
 */
function scrubElementsChain(props: Record<string, unknown>): void {
	const chain = props.$elements_chain;
	if (typeof chain !== 'string') {
		return;
	}
	if (/(?::|")attr__data-rr-private="/.test(chain)) {
		delete props.$elements_chain;
		delete props.$el_text;
		return;
	}
	let isAmbiguous = false;
	const reduced = chain.replace(CHAIN_VALUE, (_m, pre: string, key: string, value: string) => {
		// A value that ends in a backslash reads as running on into the next key, through that key's '=': which
		// quote ends it cannot be told, so the chain is not sent (fail closed).
		if (value.endsWith('=') && value.includes('\\"')) {
			isAmbiguous = true;
		}
		const plain = value.replace(/\\"/g, '"');
		return pre + key + reduceElementValue(key.slice(0, -2), plain).replace(/"/g, '\\"');
	});
	if (isAmbiguous) {
		delete props.$elements_chain;
		return;
	}
	props.$elements_chain = reduced;
}

/**
 * An event's properties, reduced in place: every event's addresses, click ids and web vitals payloads, then what
 * only some events carry (a heatmap batch, a clicked element's chain, an exception report).
 *
 * @param name - The event's name.
 * @param props - Its properties.
 */
function scrubProperties(name: unknown, props: Record<string, unknown>): void {
	scrub(props);
	scrubWebVitalsEvents(props);
	if (name === '$$heatmap') {
		scrubHeatmapData(props);
	}
	if (name === '$autocapture' || name === '$dead_click' || name === '$dead_swipe' || name === '$rageclick') {
		scrubElements(props);
	}
	if (name === '$exception') {
		scrubException(props);
	}
}

/**
 * before_send: rewrite URL-bearing and click-id properties in place. Returns the same object, or null: an event
 * the sanitizer cannot process is dropped (fail closed), never sent as it was.
 */
export function sanitizeEvent<T extends CaptureLike | null>(event: T): T {
	if (!event) {
		return event;
	}
	try {
		if (event.properties && typeof event.properties === 'object') {
			scrubProperties(event.event, event.properties as Record<string, unknown>);
		}
		if (event.$set && typeof event.$set === 'object') {
			scrub(event.$set);
		}
		if (event.$set_once && typeof event.$set_once === 'object') {
			scrub(event.$set_once);
		}
	} catch {
		// Fail closed: an event that could not be reduced is not sent.
		return null as T;
	}
	return event;
}
