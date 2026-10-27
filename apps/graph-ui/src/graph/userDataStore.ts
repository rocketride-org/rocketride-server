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
// GRAPH - USER DATA STORE (saved queries and label styles: the pure bags)
// =============================================================================
//
// What a person keeps per connection, as stored: saved queries under
// `graph.savedQueries` and label styles under `graph.styles`, each a bag keyed
// by the connection's endpoint key, and never in the same place. Where the
// bags live follows the mount (graph/userData.ts):
//
//   full app   two keys of the shell's workspace preferences, behind the
//              page's pin (graph/workspacePin.ts);
//   dev tool   two files of the CONTROLLER in the user's store,
//              SAVED_QUERIES_PATH and STYLES_PATH, one bag per account each
//              (graph/userDataFile.ts); frames read and change them through
//              ops.
//
// Saved queries follow sql-ui's (history/savedQueries.ts): nothing is
// recorded on its own and nothing is trimmed. A save past a bound is REFUSED
// with a sentence, never made room for by dropping an older one. Styles are
// bounded the same way, and a person's style edit is FIELD BY FIELD (merged
// into what is stored, so two quick edits never undo each other). The one
// automatic write, the labels' colour slots (`assignmentFor`), only adds the
// slots of new labels, releases a slot only when a new label needs one and a
// complete schema no longer lists its label, and is skipped (never an error)
// when it does not fit: the label is still drawn in its colour.
//
// Everything here is pure. What may cross from a frame is checked here, so the
// controller never writes anything but well-formed entries into the user's
// file. The preference keys and the persisted field names must never change:
// renaming one silently orphans every user's data. A write keeps what this
// build cannot read (an entry it cannot parse, a field it does not know) where
// it was, so a newer build's data survives an older build's edit.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';
import type { IPrefsAccessor } from 'shared/explorer';
import { isPlainObject } from 'shared/explorer/checks';
import { CHART_COLOR_VARS, TYPE_COLOR_SLOTS, nextAssignments } from './colors';
import type { BadgeMode, IConnectionStyle, ILabelStyle, ISavedQuery, ITypeStyle, LabelSize, SavedEdit, StyleEdit } from './userData';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Preference key holding every connection's saved queries. */
export const SAVED_QUERIES_PREF = 'graph.savedQueries';

/** Preference key holding every connection's label and relationship-type styles. */
export const STYLES_PREF = 'graph.styles';

/** The dev tool's saved-queries file (beside the history file, in the user's store): written only on a person's change. */
export const SAVED_QUERIES_PATH = '@/User/.workspace/rocketride.graph.saved.json';

/** The dev tool's styles file: a person's style edits, and the labels' colour slots. */
export const STYLES_PATH = '@/User/.workspace/rocketride.graph.styles.json';

/** Saved queries one connection keeps. */
export const MAX_SAVED_QUERIES = 50;

/** Characters of statement one saved query holds. */
export const MAX_SAVED_CYPHER_CHARS = 16 * 1024;

/** Characters of name one saved query holds. */
export const MAX_SAVED_NAME_CHARS = 120;

/**
 * Characters every connection's saved queries may take as the file is written (two-space indented JSON). With
 * {@link MAX_STYLES_BAG_CHARS} one account's bag always fits the dev-tool file's cap (shared/explorer/devtool/prefs
 * MAX_PREFS_FILE_CHARS, 512 K characters).
 */
export const MAX_SAVED_BAG_CHARS = 256 * 1024;

/** Characters every connection's styles may take as the file is written. */
export const MAX_STYLES_BAG_CHARS = 64 * 1024;

/** Characters of one caption choice (a property name, or a special). */
export const MAX_CAPTION_CHARS = 256;

/** The style of a connection nobody has styled (graph/userData.ts re-exports it). */
export const EMPTY_STYLE: IConnectionStyle = Object.freeze({ assigned: Object.freeze({}), labels: Object.freeze({}), types: Object.freeze({}) });

/** The sizes and badge modes a style may name. */
const SIZES: readonly LabelSize[] = ['S', 'M', 'L'];
const BADGES: readonly BadgeMode[] = ['initials', 'dot', 'none'];

// =============================================================================
// TYPES
// =============================================================================

/** A bag as stored: per connection, whatever was written (this build reads what it can). */
export type StoredBag = Record<string, unknown>;

/** The id and time a new saved query is given (made where it is saved). */
export interface ISavedMade {
	id: string;
	at: number;
}

/** The colour slots to add (new labels) and release (labels a complete schema no longer lists). */
export interface IAssignment {
	add: Readonly<Record<string, number>>;
	release: readonly string[];
}

/** A style change: a person's edit, or the owning realm's colour slots (never from a frame). */
export type StyleChange = StyleEdit | ({ kind: 'assign' } & IAssignment);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * A refusal: nothing was changed.
 *
 * @param message - The sentence the user reads.
 * @returns The error.
 */
function refuse(message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'invalid', tool: 'userDataEdit', message });
}

/** Characters a bag takes as the file is written. */
const writtenChars = (value: unknown): number => JSON.stringify(value, null, 2).length;

/**
 * Set an entry of a record keyed by labels or types. A label may be named `__proto__`, `constructor` or `toString`:
 * it is set as an own entry (never the prototype), and it is read with Object.hasOwn (never an inherited member).
 *
 * @param record - The record.
 * @param key - The label or type.
 * @param value - Its value.
 */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Whether a value is a chart colour slot.
 *
 * @param value - Anything.
 * @returns True for an integer index into CHART_COLOR_VARS.
 */
export function isSlot(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CHART_COLOR_VARS.length;
}

/**
 * Whether a value is a well-formed saved query.
 *
 * @param value - Anything.
 * @returns True for a saved query.
 */
function isSavedQuery(value: unknown): value is ISavedQuery {
	return isPlainObject(value)
		&& typeof value.id === 'string' && value.id !== ''
		&& typeof value.name === 'string'
		&& typeof value.cypher === 'string'
		&& typeof value.savedAt === 'number' && Number.isFinite(value.savedAt);
}

/**
 * A saved query with its own fields only, in the persisted order.
 *
 * @param query - The query.
 * @returns A clean copy.
 */
function cleanQuery(query: ISavedQuery): ISavedQuery {
	return { id: query.id, name: query.name, cypher: query.cypher, savedAt: query.savedAt };
}

/**
 * Whether a character may not appear in a name: control characters, and the marks and overrides that change the
 * direction text is shown in (a name is shown on one line, in a list and on a tab).
 *
 * @param code - The character's code point.
 * @returns True when it is dropped.
 */
function unsafeInName(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * A name that fits: one plain line (runs of white space, line breaks included, become one space; control characters
 * and direction overrides are dropped), trimmed.
 *
 * @param name - What the user typed.
 * @param verb - What was being done ('saved', 'renamed').
 * @returns The name.
 * @throws ExplorerToolError `invalid` when it is empty or too long.
 */
function fittingName(name: string, verb: string): string {
	const plain = Array.from(name.replace(/\s+/g, ' ')).filter((char) => !unsafeInName(char.codePointAt(0) ?? 0)).join('');
	const trimmed = plain.replace(/ {2,}/g, ' ').trim();
	if (trimmed === '') throw refuse(`The query was not ${verb}: give it a name.`);
	if (trimmed.length > MAX_SAVED_NAME_CHARS) throw refuse(`The query was not ${verb}: a name holds at most ${MAX_SAVED_NAME_CHARS} characters.`);
	return trimmed;
}

// =============================================================================
// SAVED QUERIES
// =============================================================================

/**
 * Read a stored bag, keeping the well-formed queries only. Never throws: a damaged entry is not shown, and not a
 * reason to lose the rest (a write keeps it; {@link applySavedEdit}).
 *
 * @param raw - What the preferences hold.
 * @returns Per connection, its queries newest first.
 */
export function readSavedQueriesBag(raw: unknown): Record<string, ISavedQuery[]> {
	if (!isPlainObject(raw)) return {};
	const bag: Record<string, ISavedQuery[]> = {};
	for (const [key, list] of Object.entries(raw)) {
		if (!Array.isArray(list)) continue;
		const kept = list.filter(isSavedQuery).map(cleanQuery);
		if (kept.length > 0) bag[key] = kept;
	}
	return bag;
}

/**
 * Apply one edit to a stored bag. The bag given is never changed, and what this build cannot read stays where it
 * was: other connections' lists as stored, entries it cannot parse, and fields it does not know.
 *
 * @param bag - The current bag, as stored.
 * @param key - The connection's endpoint key.
 * @param edit - The (checked) edit.
 * @param made - The id and time a save gives its query (a save repeating an id replaces that query in place).
 * @returns The new bag (the same one when nothing changed).
 * @throws ExplorerToolError `invalid` when a cap or a missing query refuses it; nothing is changed.
 */
export function applySavedEdit(bag: StoredBag, key: string, edit: SavedEdit, made: ISavedMade): StoredBag {
	const list: unknown[] = Array.isArray(bag[key]) ? (bag[key] as unknown[]) : [];
	const hasId = (entry: unknown, id: string): boolean => isPlainObject(entry) && entry.id === id;
	let next: unknown[];
	switch (edit.action) {
		case 'delete': {
			if (!list.some((entry) => hasId(entry, edit.id))) return bag;
			next = list.filter((entry) => !hasId(entry, edit.id));
			break;
		}
		case 'rename': {
			const name = fittingName(edit.name, 'renamed');
			if (!list.some((entry) => isSavedQuery(entry) && entry.id === edit.id)) throw refuse('The query was not renamed: it no longer exists.');
			next = list.map((entry) => (isSavedQuery(entry) && entry.id === edit.id ? { ...entry, name } : entry));
			break;
		}
		default: {
			const name = fittingName(edit.name, 'saved');
			const { cypher } = edit;
			if (cypher.trim() === '') throw refuse('The query was not saved: there is no statement to save.');
			if (cypher.length > MAX_SAVED_CYPHER_CHARS) {
				throw refuse(`The query was not saved: a saved query holds at most ${MAX_SAVED_CYPHER_CHARS.toLocaleString('en-US')} characters, and this one has ${cypher.length.toLocaleString('en-US')}.`);
			}
			const query: ISavedQuery = { id: made.id, name, cypher, savedAt: made.at };
			if (list.some((entry) => hasId(entry, query.id))) {
				next = list.map((entry) => (hasId(entry, query.id) ? { ...(entry as object), ...query } : entry));
			} else {
				// Counted as the user sees them: an entry nobody can see or delete never blocks a save.
				if (list.filter(isSavedQuery).length >= MAX_SAVED_QUERIES) {
					throw refuse(`The query was not saved: this connection already keeps ${MAX_SAVED_QUERIES} saved queries. Delete one to save another.`);
				}
				next = [query, ...list];
			}
		}
	}
	const result: StoredBag = { ...bag };
	if (next.length > 0) result[key] = next;
	else delete result[key];
	if (edit.action !== 'delete' && writtenChars(result) > MAX_SAVED_BAG_CHARS) {
		throw refuse(`The query was not ${edit.action === 'save' ? 'saved' : 'renamed'}: saved queries are full (${MAX_SAVED_BAG_CHARS / 1024} KB across all connections). Delete some to save more.`);
	}
	return result;
}

/**
 * One connection's saved queries, read through a preferences accessor.
 *
 * @param prefs - The accessor (workspace preferences, the controller's file, or memory).
 * @param key - The connection's endpoint key.
 * @returns Its saved queries, newest first (empty when none).
 */
export function savedQueriesIn(prefs: IPrefsAccessor, key: string): ISavedQuery[] {
	return readSavedQueriesBag(prefs.getPref(SAVED_QUERIES_PREF))[key] ?? [];
}

/**
 * Apply one edit through a preferences accessor. A refused edit writes nothing.
 *
 * @param prefs - The accessor.
 * @param key - The connection's endpoint key.
 * @param edit - The (checked) edit.
 * @param made - The id and time a save gives its query.
 * @throws ExplorerToolError `invalid` when the edit is refused.
 */
export function editSavedIn(prefs: IPrefsAccessor, key: string, edit: SavedEdit, made: ISavedMade): void {
	const stored = prefs.getPref(SAVED_QUERIES_PREF);
	const bag: StoredBag = isPlainObject(stored) ? stored : {};
	const next = applySavedEdit(bag, key, edit, made);
	if (next !== bag) prefs.setPref(SAVED_QUERIES_PREF, next);
}

// =============================================================================
// STYLES
// =============================================================================

/**
 * Whether a value is a caption choice.
 *
 * @param value - Anything.
 * @returns True for a non-empty string within MAX_CAPTION_CHARS.
 */
function isCaption(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && value.length <= MAX_CAPTION_CHARS;
}

/**
 * One label's style with its known, valid fields only.
 *
 * @param value - Anything.
 * @returns The style, or null when it holds nothing this build uses.
 */
function readLabelStyle(value: unknown): ILabelStyle | null {
	if (!isPlainObject(value)) return null;
	const style: ILabelStyle = {};
	if (isSlot(value.slot)) style.slot = value.slot;
	if (SIZES.includes(value.size as LabelSize)) style.size = value.size as LabelSize;
	if (BADGES.includes(value.badge as BadgeMode)) style.badge = value.badge as BadgeMode;
	if (isCaption(value.caption)) style.caption = value.caption;
	return Object.keys(style).length > 0 ? style : null;
}

/**
 * One relationship type's style with its known, valid fields only.
 *
 * @param value - Anything.
 * @returns The style, or null when it holds nothing this build uses.
 */
function readTypeStyle(value: unknown): ITypeStyle | null {
	return isPlainObject(value) && isTypeSlot(value.slot) ? { slot: value.slot } : null;
}

/**
 * Whether a value is a slot a relationship type may be drawn in: only the colours measured at 3:1 against the canvas
 * in every shipped theme (graph/colors.ts TYPE_COLOR_SLOTS). A thin line in a colour that fails it would be hard to see.
 *
 * @param value - Anything.
 * @returns True for one of TYPE_COLOR_SLOTS.
 */
export function isTypeSlot(value: unknown): value is number {
	return isSlot(value) && TYPE_COLOR_SLOTS.includes(value);
}

/**
 * Read one connection's stored style, keeping what is valid. Never throws.
 *
 * @param raw - What the bag holds for the connection.
 * @returns The style ({@link EMPTY_STYLE} when there is none).
 */
export function readConnectionStyle(raw: unknown): IConnectionStyle {
	if (!isPlainObject(raw)) return EMPTY_STYLE;
	const assigned: Record<string, number> = {};
	if (isPlainObject(raw.assigned)) for (const [label, slot] of Object.entries(raw.assigned)) if (isSlot(slot)) setOwn(assigned, label, slot);
	const labels: Record<string, ILabelStyle> = {};
	if (isPlainObject(raw.labels)) {
		for (const [label, value] of Object.entries(raw.labels)) {
			const style = readLabelStyle(value);
			if (style) setOwn(labels, label, style);
		}
	}
	const types: Record<string, ITypeStyle> = {};
	if (isPlainObject(raw.types)) {
		for (const [type, value] of Object.entries(raw.types)) {
			const style = readTypeStyle(value);
			if (style) setOwn(types, type, style);
		}
	}
	return { assigned, labels, types };
}

/**
 * Merge a field-level patch into a stored entry (a label's or a type's), keeping fields this build does not know.
 *
 * @param stored - What is stored now (anything).
 * @param patch - The fields to set.
 * @param clear - The fields to remove.
 * @returns The new entry, or null when it holds nothing any more.
 */
function patched(stored: unknown, patch: object | undefined, clear: readonly string[] | undefined): Record<string, unknown> | null {
	const next: Record<string, unknown> = { ...(isPlainObject(stored) ? stored : {}), ...(patch ?? {}) };
	for (const field of clear ?? []) delete next[field];
	return Object.keys(next).length > 0 ? next : null;
}

/**
 * Apply one style change to a stored bag. The bag given is never changed; other connections, and fields this build
 * does not know, stay as stored. A person's edit merges field by field. An assignment adds the slots of new labels
 * and releases the ones it names, and never moves a label that keeps its slot.
 *
 * @param bag - The current bag, as stored.
 * @param key - The connection's endpoint key.
 * @param change - A person's (checked) edit, or the colour slots.
 * @returns The new bag (the same one when nothing changed, or when an assignment does not fit).
 * @throws ExplorerToolError `invalid` when a person's edit does not fit; nothing is changed.
 */
export function applyStyleChange(bag: StoredBag, key: string, change: StyleChange): StoredBag {
	const stored = isPlainObject(bag[key]) ? (bag[key] as Record<string, unknown>) : {};
	const sub = (name: string): Record<string, unknown> => (isPlainObject(stored[name]) ? { ...(stored[name] as Record<string, unknown>) } : {});
	const entry: Record<string, unknown> = { ...stored, assigned: sub('assigned'), labels: sub('labels'), types: sub('types') };
	switch (change.kind) {
		case 'assign': {
			const assigned = entry.assigned as Record<string, unknown>;
			const released = change.release.filter((label) => Object.hasOwn(assigned, label));
			const fresh = Object.entries(change.add).filter(([label, slot]) => isSlot(slot) && (!isSlot(assigned[label]) || released.includes(label)));
			if (fresh.length === 0 && released.length === 0) return bag;
			for (const label of released) delete assigned[label];
			for (const [label, slot] of fresh) setOwn(assigned, label, slot);
			break;
		}
		case 'reset':
			// A person's choices go; the slots stay, so no label changes colour by itself.
			if (Object.keys(entry.labels as object).length === 0 && Object.keys(entry.types as object).length === 0) return bag;
			entry.labels = {};
			entry.types = {};
			break;
		case 'label': {
			const labels = entry.labels as Record<string, unknown>;
			const next = patched(Object.hasOwn(labels, change.label) ? labels[change.label] : undefined, change.patch, change.clear);
			if (next === null) delete labels[change.label];
			else setOwn(labels, change.label, next);
			break;
		}
		case 'type': {
			if (change.patch?.slot !== undefined && !isTypeSlot(change.patch.slot)) throw refuse('The style was not changed: a relationship type cannot be drawn in that colour (it is too faint against the canvas in some themes).');
			const types = entry.types as Record<string, unknown>;
			const next = patched(Object.hasOwn(types, change.type) ? types[change.type] : undefined, change.patch, change.clear);
			if (next === null) delete types[change.type];
			else setOwn(types, change.type, next);
			break;
		}
	}
	const result: StoredBag = { ...bag, [key]: entry };
	if (change.kind !== 'reset' && writtenChars(result) > MAX_STYLES_BAG_CHARS) {
		if (change.kind === 'assign') return bag;
		throw refuse(`The style was not changed: styles are full (${MAX_STYLES_BAG_CHARS / 1024} KB across all connections). Resetting a connection's styles frees what its own choices take.`);
	}
	return result;
}

/**
 * The colour slots a connection's schema calls for: new labels take the lowest free slots in sorted order
 * (`nextAssignments`). When a new label finds no free slot and the schema read is complete, the slots of labels it no
 * longer lists are released first. Labels that keep their slot never move.
 *
 * @param assigned - The slots given so far.
 * @param labels - Every label of the connection's schema (any order, duplicates allowed).
 * @param complete - True when the read lists every label (fresh, not truncated).
 * @returns What to add and release (both empty when nothing changes).
 */
export function assignmentFor(assigned: Readonly<Record<string, number>>, labels: Iterable<string>, complete: boolean): IAssignment {
	const listed = Array.from(new Set(labels)).filter((label) => label !== '');
	const add = nextAssignments(assigned, listed);
	const waiting = listed.filter((label) => !Object.hasOwn(assigned, label) && !Object.hasOwn(add, label));
	if (!complete || waiting.length === 0) return { add, release: [] };
	const gone = Object.keys(assigned).filter((label) => !listed.includes(label));
	if (gone.length === 0) return { add, release: [] };
	const kept: Record<string, number> = {};
	for (const [label, slot] of Object.entries(assigned)) if (!gone.includes(label)) setOwn(kept, label, slot);
	return { add: nextAssignments(kept, listed), release: gone };
}

/**
 * A style with an assignment applied (what the owning realm shows before it is written).
 *
 * @param style - The stored style.
 * @param delta - What to add and release.
 * @returns The style as it will be.
 */
export function withAssignment(style: IConnectionStyle, delta: IAssignment): IConnectionStyle {
	const assigned: Record<string, number> = {};
	for (const [label, slot] of Object.entries(style.assigned)) if (!delta.release.includes(label)) setOwn(assigned, label, slot);
	for (const [label, slot] of Object.entries(delta.add)) setOwn(assigned, label, slot);
	return { ...style, assigned };
}

/** Styles read per stored entry object, so a style read twice is the same object. */
const styleCache = new WeakMap<object, IConnectionStyle>();

/**
 * One connection's style, read through a preferences accessor.
 *
 * @param prefs - The accessor.
 * @param key - The connection's endpoint key.
 * @returns Its style (the same object while the stored entry is).
 */
export function styleIn(prefs: IPrefsAccessor, key: string): IConnectionStyle {
	const bag = prefs.getPref(STYLES_PREF);
	const raw = isPlainObject(bag) ? bag[key] : undefined;
	if (!isPlainObject(raw)) return EMPTY_STYLE;
	let style = styleCache.get(raw);
	if (!style) {
		style = readConnectionStyle(raw);
		styleCache.set(raw, style);
	}
	return style;
}

/**
 * Apply one style change through a preferences accessor. A refused edit writes nothing.
 *
 * @param prefs - The accessor.
 * @param key - The connection's endpoint key.
 * @param change - The (checked) change.
 * @returns True when something was written.
 * @throws ExplorerToolError `invalid` when a person's edit is refused.
 */
export function editStyleIn(prefs: IPrefsAccessor, key: string, change: StyleChange): boolean {
	const stored = prefs.getPref(STYLES_PREF);
	const bag: StoredBag = isPlainObject(stored) ? stored : {};
	const next = applyStyleChange(bag, key, change);
	if (next === bag) return false;
	prefs.setPref(STYLES_PREF, next);
	return true;
}

// =============================================================================
// CAPTIONS FROM AN OLDER FORMAT (the full app's `graph.captions`, before 1.3)
// =============================================================================

/**
 * One connection's caption choices in the older format (`{ [key]: { [label]: choice } }`), the valid ones only.
 *
 * @param raw - What the older key holds.
 * @param key - The connection's endpoint key.
 * @returns Label to caption choice (empty when there are none).
 */
export function legacyCaptionsIn(raw: unknown, key: string): Record<string, string> {
	const out: Record<string, string> = {};
	const own = isPlainObject(raw) && Object.hasOwn(raw, key) && isPlainObject(raw[key]) ? (raw[key] as Record<string, unknown>) : null;
	if (own) for (const [label, choice] of Object.entries(own)) if (isCaption(choice)) setOwn(out, label, choice);
	return out;
}

/**
 * A style with older caption choices shown for the labels it has no caption for (the style's own always wins).
 *
 * @param style - The style.
 * @param captions - Label to caption choice.
 * @returns The style as it will be once they are moved in (the same object when none applies).
 */
export function withLegacyCaptions(style: IConnectionStyle, captions: Readonly<Record<string, string>>): IConnectionStyle {
	const missing = Object.entries(captions).filter(([label]) => !(Object.hasOwn(style.labels, label) && style.labels[label].caption !== undefined));
	if (missing.length === 0) return style;
	const labels: Record<string, ILabelStyle> = { ...style.labels };
	for (const [label, caption] of missing) setOwn(labels, label, { ...(Object.hasOwn(labels, label) ? labels[label] : {}), caption });
	return { ...style, labels };
}

/**
 * Move the older caption choices of every connection into the styles (only for labels with no caption yet). A choice
 * that does not fit a full styles bag stays under the older key (still shown, and tried again with a later change);
 * the key is removed once nothing is left in it.
 *
 * @param prefs - The accessor (both keys).
 * @param legacyPref - The older key.
 * @returns True when anything was written.
 */
export function moveLegacyCaptions(prefs: IPrefsAccessor, legacyPref: string): boolean {
	const raw = prefs.getPref(legacyPref);
	if (raw === undefined) return false;
	const left: Record<string, Record<string, string>> = {};
	let moved = 0;
	if (isPlainObject(raw)) {
		for (const key of Object.keys(raw)) {
			const style = styleIn(prefs, key);
			for (const [label, caption] of Object.entries(legacyCaptionsIn(raw, key))) {
				// The style's own caption wins: that choice is done.
				if (Object.hasOwn(style.labels, label) && style.labels[label].caption !== undefined) continue;
				try {
					editStyleIn(prefs, key, { kind: 'label', label, patch: { caption } });
					moved += 1;
				} catch {
					// Styles are full: kept where it was, never lost.
					if (!Object.hasOwn(left, key)) setOwn(left, key, {});
					setOwn(left[key], label, caption);
				}
			}
		}
	}
	const remaining = Object.keys(left).length > 0;
	// Nothing could be moved: leave the older key exactly as it was (no write at all).
	if (moved === 0 && remaining) return false;
	prefs.setPref(legacyPref, remaining ? left : undefined);
	return true;
}

// =============================================================================
// FROM A FRAME
// =============================================================================

/** The refusal of an edit this app does not make. */
const notOurs = (): never => {
	throw refuse('Nothing was changed: the edit is not one this app makes.');
};

/**
 * Check a saved-query edit that arrived from a frame and rebuild it with its own fields only. The caps are applied
 * where the bag is ({@link applySavedEdit}).
 *
 * @param value - The edit.
 * @returns The edit.
 * @throws ExplorerToolError `invalid` when it is not one this app makes.
 */
export function checkSavedEdit(value: unknown): SavedEdit {
	if (!isPlainObject(value)) return notOurs();
	const id = typeof value.id === 'string' && value.id !== '' ? value.id : null;
	switch (value.action) {
		case 'delete':
			return id !== null ? { action: 'delete', id } : notOurs();
		case 'rename':
			return id !== null && typeof value.name === 'string' ? { action: 'rename', id, name: value.name } : notOurs();
		case 'save':
			return typeof value.name === 'string' && typeof value.cypher === 'string' ? { action: 'save', name: value.name, cypher: value.cypher } : notOurs();
		default:
			return notOurs();
	}
}

/**
 * Check a field-level patch that arrived from a frame.
 *
 * @param value - The patch (or undefined).
 * @param fields - Each field it may name, with its check.
 * @returns The patch with those fields only, or null when it names anything else or a value that is not valid.
 */
function checkedPatch(value: unknown, fields: Record<string, (v: unknown) => boolean>): Record<string, unknown> | null {
	if (value === undefined) return {};
	if (!isPlainObject(value)) return null;
	const out: Record<string, unknown> = {};
	for (const [field, v] of Object.entries(value)) {
		if (!Object.hasOwn(fields, field) || !fields[field](v)) return null;
		out[field] = v;
	}
	return out;
}

/**
 * Check a field list that arrived from a frame.
 *
 * @param value - The list (or undefined).
 * @param fields - The fields it may name.
 * @returns The list, or null when it is not a list of those names.
 */
function checkedClear(value: unknown, fields: readonly string[]): string[] | null {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((field) => typeof field === 'string' && fields.includes(field)) ? [...(value as string[])] : null;
}

/** The label fields a frame may set, each with its check. */
const LABEL_PATCH: Record<string, (v: unknown) => boolean> = {
	slot: isSlot,
	size: (v) => SIZES.includes(v as LabelSize),
	badge: (v) => BADGES.includes(v as BadgeMode),
	caption: isCaption,
};

/**
 * Check a style edit that arrived from a frame: every field it sets must be a valid one, and every field it clears a
 * known one (an assignment never comes from a frame; only the realm that owns the schema assigns).
 *
 * @param value - The edit.
 * @returns The edit, with its own fields only.
 * @throws ExplorerToolError `invalid` when it is not one this app makes.
 */
export function checkStyleEdit(value: unknown): StyleEdit {
	if (!isPlainObject(value)) return notOurs();
	switch (value.kind) {
		case 'reset':
			return { kind: 'reset' };
		case 'label': {
			const patch = checkedPatch(value.patch, LABEL_PATCH);
			const clear = checkedClear(value.clear, Object.keys(LABEL_PATCH));
			if (typeof value.label !== 'string' || patch === null || clear === null) return notOurs();
			return { kind: 'label', label: value.label, patch: patch as Partial<ILabelStyle>, clear: clear as Array<keyof ILabelStyle> };
		}
		case 'type': {
			const patch = checkedPatch(value.patch, { slot: isTypeSlot });
			const clear = checkedClear(value.clear, ['slot']);
			if (typeof value.type !== 'string' || patch === null || clear === null) return notOurs();
			return { kind: 'type', type: value.type, patch: patch as Partial<ITypeStyle>, clear: clear as Array<keyof ITypeStyle> };
		}
		default:
			return notOurs();
	}
}
