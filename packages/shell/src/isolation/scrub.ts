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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// SCRUB — what the root rewrites in everything it sends to an app (PR2a-2, N1)
// =============================================================================
//
// `scrubOutbound` order (plan section 4.4):
//   1. identity fields by key (aliases.ts);
//   2. replacement: the realm's `tk_` → its handle, `pk_` → "", real task id →
//      the task-id alias; every `project_id`/`projectId` value and
//      project-keyed map key → the realm's `rp_` alias (any id); high-entropy
//      ids (own and `knownProjects`) inside strings, raw and URL-encoded;
//   3. backstop: the credential and `rrapp.` patterns, and exact match against
//      every seen token and task id, every realm's live ledger values, the
//      session token, the API key and the high-entropy ids. A hit inside
//      `body.notes[*]` turns that note into "[redacted]", a hit inside an
//      engine error text is redacted in place, any other hit is a
//      `credential` denial (fail closed).
//
// The app's own file content (`rrext_store`) is not rewritten by key and the
// patterns are not applied to it; exact matches still are. `__rrbin`
// payloads are app data and are not scanned (plan section 4.4, scope).
// =============================================================================

import type { DAPMessage } from 'rocketride';
import type { IKnownProjects } from './aliases';
import { isHighEntropy, KNOWN_LIMIT, MINTED_PROJECT_RE, PROJECT_KEYS, rewriteIdentity } from './aliases';
import { deny } from './denial';
import type { IGatedRequest } from './gate';
import type { ILedger, IRunEntry } from './ledger';
import type { IRealmGrant } from './types';
import { isWireBinary } from './walk';

/** What replaces a backstop hit in a note or an error text. */
export const REDACTED = '[redacted]';

/** An engine-shaped credential anywhere in a string (Appendix L). */
const CREDENTIAL_RE = /(?:tk|pk)_[A-Za-z0-9_-]{16,}/g;
/** A minted project id anywhere in a string: another app's, or one no realm holds any more. */
const MINTED_ANYWHERE_RE = /rrapp\.[a-z2-7]{25}\.[0-9a-f-]{36}/g;
/** The shortest exact value the backstop matches (shorter values would match ordinary text). */
const NEEDLE_MIN = 8;

/** What the scrubber needs for one realm. */
export interface IScrubContext {
	/** The realm's ledger: its own runs are replaced, never denied. */
	ledger: ILedger;
	/** The realm's grant (`frame.identity` holds its user alias). */
	grant: IRealmGrant;
	/** The root-wide foreign project ids. */
	known: IKnownProjects;
	/** This realm's aliases of project ids it does not own: real id → `rp_` (bounded, oldest evicted). */
	aliases: Map<string, string>;
	/** A fresh `rp_` alias. */
	mintAlias(): string;
	/** Whether any realm's ledger holds this project id as its own (such an id is never "foreign"). */
	ownedByAnyRealm(projectId: string): boolean;
	/**
	 * Exact values no realm may receive in clear: every seen token and real
	 * task id, every realm's live ledger values, the session token and the
	 * shell API keys.
	 */
	needles(): string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Opaque to the scrubber: typed arrays, buffers and exact wire binary members. */
const isOpaque = (v: unknown): boolean => ArrayBuffer.isView(v) || v instanceof ArrayBuffer || isWireBinary(v);

/** One scrub of one value: the replacement pairs and needles, computed once. */
interface IPass {
	subst(s: string): string;
	projectAlias(id: string): string;
	isProjectKey(key: string): boolean;
	/** Notes a project id the value names (first sight: a foreign id joins `knownProjects`). */
	sight(id: string): void;
	hit(s: string): boolean;
	redact(s: string): string;
}

const replaceAll = (s: string, from: string, to: string): string => (s.includes(from) ? s.split(from).join(to) : s);

/**
 * Prepares one scrub for a realm.
 *
 * @param ctx - The realm's scrub context.
 * @param extraRuns - Runs to scrub besides the live ones (a run the answer just ended).
 * @param patterns - Whether the credential and `rrapp.` patterns apply (not to the app's own file content).
 */
function prepare(ctx: IScrubContext, extraRuns: readonly IRunEntry[], patterns: boolean): IPass {
	const runs = [...ctx.ledger.runs()];
	for (const r of extraRuns) if (!runs.includes(r)) runs.push(r);
	const ownProject = new Map(runs.map((r) => [r.projectId, r] as const));

	// The realm's own values: replaced, longest first.
	const pairs: Array<[string, string]> = [];
	for (const r of runs) {
		pairs.push([r.token, r.handle], [r.publicToken, ''], [r.taskId, r.taskIdAlias]);
		if (isHighEntropy(r.projectId)) pairs.push([r.projectId, r.projectAlias], [encodeURIComponent(r.projectId), r.projectAlias]);
	}
	const ownPairs = pairs.filter(([from]) => from.length >= NEEDLE_MIN).sort((a, b) => b[0].length - a[0].length);
	// Foreign high-entropy ids the root saw: replaced by this realm's alias (minted only when present).
	const knownForms: Array<[string, string]> = [];
	for (const id of ctx.known.highEntropy()) {
		if (ownProject.has(id)) continue;
		knownForms.push([id, id]);
		const encoded = encodeURIComponent(id);
		if (encoded !== id) knownForms.push([encoded, id]);
	}
	knownForms.sort((a, b) => b[0].length - a[0].length);

	let aliasValues: Set<string> | null = null;
	const isRealmAlias = (id: string): boolean => {
		aliasValues ??= new Set([...runs.map((r) => r.projectAlias), ...ctx.aliases.values()]);
		return aliasValues.has(id);
	};
	const projectAlias = (id: string): string => {
		const own = ownProject.get(id);
		if (own) return own.projectAlias;
		if (isRealmAlias(id)) return id;
		let alias = ctx.aliases.get(id);
		if (alias === undefined) {
			alias = ctx.mintAlias();
			ctx.aliases.set(id, alias);
			while (ctx.aliases.size > KNOWN_LIMIT) ctx.aliases.delete(ctx.aliases.keys().next().value as string);
			aliasValues = null;
		}
		return alias;
	};

	// The backstop's exact values: everything the root holds, plus every high-entropy id in the scrub sets.
	const needleSet = new Set(ctx.needles());
	for (const r of runs) for (const v of [r.token, r.publicToken, r.taskId]) needleSet.add(v);
	for (const r of runs) if (isHighEntropy(r.projectId)) needleSet.add(r.projectId);
	for (const id of ctx.known.highEntropy()) needleSet.add(id);
	const needles = [...needleSet].filter((n) => typeof n === 'string' && n.length >= NEEDLE_MIN).sort((a, b) => b.length - a.length);

	return {
		subst(s) {
			let out = s;
			for (const [from, to] of ownPairs) out = replaceAll(out, from, to);
			for (const [form, id] of knownForms) if (out.includes(form)) out = replaceAll(out, form, projectAlias(id));
			return out;
		},
		projectAlias,
		isProjectKey: (key) => ownProject.has(key) || ctx.known.has(key) || MINTED_PROJECT_RE.test(key),
		sight(id) {
			if (id === '' || ownProject.has(id) || isRealmAlias(id) || ctx.ownedByAnyRealm(id)) return;
			ctx.known.add(id);
			if (isHighEntropy(id) && !knownForms.some(([, k]) => k === id)) {
				knownForms.push([id, id]);
				const encoded = encodeURIComponent(id);
				if (encoded !== id) knownForms.push([encoded, id]);
				knownForms.sort((a, b) => b[0].length - a[0].length);
				needles.push(id);
			}
		},
		hit(s) {
			if (patterns) {
				CREDENTIAL_RE.lastIndex = 0;
				MINTED_ANYWHERE_RE.lastIndex = 0;
				if (CREDENTIAL_RE.test(s) || MINTED_ANYWHERE_RE.test(s)) return true;
			}
			return needles.some((n) => s.includes(n));
		},
		redact(s) {
			let out = s;
			for (const n of needles) out = replaceAll(out, n, REDACTED);
			if (patterns) out = out.replace(CREDENTIAL_RE, REDACTED).replace(MINTED_ANYWHERE_RE, REDACTED);
			return out;
		},
	};
}

/** Every `project_id`/`projectId` value of a value, at any depth. */
function eachProjectField(value: unknown, cb: (id: string) => void): void {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v !== 'object' || v === null || isOpaque(v)) continue;
		if (Array.isArray(v)) stack.push(...v);
		else
			for (const [k, x] of Object.entries(v)) {
				if (PROJECT_KEYS.has(k) && typeof x === 'string') cb(x);
				else stack.push(x);
			}
	}
}

/** Step 2 on a copy: by key (project fields and project-keyed map keys) when `byKey`, then substrings. */
function replaceIn(pass: IPass, value: unknown, byKey: boolean): unknown {
	const visit = (v: unknown): unknown => {
		if (typeof v === 'string') return pass.subst(v);
		if (typeof v !== 'object' || v === null || isOpaque(v)) return v;
		if (Array.isArray(v)) return v.map(visit);
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (byKey && PROJECT_KEYS.has(k) && typeof x === 'string') {
				out[k] = pass.projectAlias(x);
				continue;
			}
			const key = byKey && pass.isProjectKey(k) ? pass.projectAlias(k) : pass.subst(k);
			out[key] = visit(x);
		}
		return out;
	};
	return visit(value);
}

/** Whether any string (value or key) of a value is a backstop hit. */
function anyHit(pass: IPass, value: unknown): boolean {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const v = stack.pop();
		if (typeof v === 'string') {
			if (pass.hit(v)) return true;
		} else if (typeof v === 'object' && v !== null && !isOpaque(v)) {
			if (Array.isArray(v)) stack.push(...v);
			else
				for (const [k, x] of Object.entries(v)) {
					if (pass.hit(k)) return true;
					stack.push(x);
				}
		}
	}
	return false;
}

/** Step 3 for a body: a note with a hit becomes "[redacted]". */
function redactNotes(pass: IPass, body: unknown): void {
	if (!isPlainObject(body) || !Array.isArray(body.notes)) return;
	body.notes = body.notes.map((note) => (anyHit(pass, note) ? REDACTED : note));
}

/** The full scrub of a DAP message (a response or an event) for one realm; with `denyHits`, a remaining hit throws a `credential` denial. */
function scrubMessage(ctx: IScrubContext, message: DAPMessage, opts: { extraRuns: readonly IRunEntry[]; fileContent: boolean; denyHits: boolean }): DAPMessage {
	const pass = prepare(ctx, opts.extraRuns, !opts.fileContent);
	let value: unknown = message;
	if (!opts.fileContent) {
		eachProjectField(value, (id) => pass.sight(id));
		value = rewriteIdentity(ctx.grant, value);
	}
	const out = replaceIn(pass, value, !opts.fileContent) as Record<string, unknown>;
	redactNotes(pass, out.body);
	// An engine error text (success: false) is redacted in place.
	if (out.success === false && typeof out.message === 'string') out.message = pass.redact(out.message);
	if (opts.denyHits && anyHit(pass, out)) throw deny('credential', 'client.event');
	return out as unknown as DAPMessage;
}

/**
 * Scrubs any value on its way to the realm (the router's choke point): the
 * realm's own and the known high-entropy values are replaced inside strings,
 * then the backstop runs. No by-key rewriting: this also carries app-to-app
 * traffic, whose fields are the apps' own.
 *
 * @param ctx - The realm's scrub context.
 * @param value - The value.
 * @param opts - `patterns: false` for the app's own file content.
 * @returns A scrubbed copy; throws a `credential` denial on a backstop hit.
 */
export function scrubOutbound<T>(ctx: IScrubContext, value: T, opts: { patterns?: boolean } = {}): T {
	const pass = prepare(ctx, [], opts.patterns !== false);
	const out = replaceIn(pass, value, false);
	if (anyHit(pass, out)) throw deny('credential', 'outbound');
	return out as T;
}

/**
 * Scrubs one `client.request` response (after the ledger recorded it).
 *
 * @param ctx - The realm's scrub context.
 * @param req - The gated request it answers (its run is scrubbed even when the answer ended it).
 * @param response - The engine response.
 * @returns The scrubbed response. A hit left outside notes and error text is
 *   denied at the choke point (`scrubOutbound` in the router's post, N1-e),
 *   which answers the same request id.
 */
export function scrubResponse(ctx: IScrubContext, req: IGatedRequest, response: DAPMessage): DAPMessage {
	return scrubMessage(ctx, response, { extraRuns: req.run ? [req.run] : [], fileContent: req.command === 'rrext_store', denyHits: false });
}

/**
 * Scrubs one engine event on its way to the realm that owns its run.
 *
 * @param ctx - The realm's scrub context.
 * @param event - The engine event.
 * @returns The scrubbed event; throws a `credential` denial (the caller drops it).
 */
export function scrubEvent(ctx: IScrubContext, event: DAPMessage): DAPMessage {
	return scrubMessage(ctx, event, { extraRuns: [], fileContent: false, denyHits: true });
}

/**
 * Scrubs the text of a thrown engine error: replacements, then every backstop hit redacted in place.
 *
 * @param ctx - The realm's scrub context.
 * @param text - The error message.
 * @param run - The run the request named, if any.
 * @returns The text to send.
 */
export function scrubErrorText(ctx: IScrubContext, text: string, run?: IRunEntry): string {
	const pass = prepare(ctx, run ? [run] : [], true);
	return pass.redact(pass.subst(text));
}
