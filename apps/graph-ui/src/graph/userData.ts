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
// GRAPH - USER DATA (label styles and saved queries, per connection)
// =============================================================================
//
// What a person keeps for a connection besides history: how each label and
// relationship type is drawn, and the queries they saved. Every mount reaches
// it through `env.userData` (IGraphUserData); where it is kept differs per
// mount, and `privacyNote` says so in one true sentence, derived from where it
// is kept right now.
//
// WHERE THEY ARE KEPT (the bags themselves: graph/userDataStore.ts). Styles and
// saved queries are always kept apart, so the one automatic writer (colour
// slots) can never touch a saved query:
//
//   full app      two keys of the workspace preferences, behind the page's pin
//                 (graph/workspacePin.ts), read only once the shell has loaded
//                 them;
//   dev tool      two files of the CONTROLLER, one section per account each
//                 (graph/userDataFile.ts): frames reach them through ops
//                 (devtool/remoteUserData.ts);
//   anything else memory, for the session (`createMemoryUserData`).
//
// COLOUR SLOTS. Slots index the shell's six chart colours (graph/colors.ts
// CHART_COLOR_VARS). The realm that owns the schema (the full app, the
// controller) gives every label of a loaded schema its slot once
// (`followAssignments`): labels already given one keep it, new ones take the
// lowest free slot in sorted order, and a slot is released only when a new
// label needs one and a complete schema read no longer lists its label. The
// slots come from the connection's whole schema, never from the labels one
// screen happens to draw, so every screen agrees. The owning realm shows them
// at once and writes them only to a store it has READ: never while it loads,
// never to a session-only fallback, never before the full app's preferences
// are loaded. The controller writes them debounced; the full app only with the
// person's next change in that page (`holdSlots`), since each page writes its
// whole preferences partition and an older page must not overwrite by itself.
// The full app also shows the caption choices 1.2 kept under `graph.captions`
// and moves them into the styles the same way, once. A reset clears a person's choices and keeps the
// slots, so colours stay where they are.
//
// READY. A style read says whether its store has been read (`ready`): until
// then a screen draws labels in a neutral colour rather than in colours that
// would change a moment later. Nothing here holds a client, so a frame can
// import it.
// =============================================================================

import type { IPrefsAccessor } from 'shared/explorer';
import type { IReadable } from '../env';
import type { ISchemaStore } from './schemaStore';
import { EMPTY_STYLE, SAVED_QUERIES_PREF, assignmentFor, editSavedIn, editStyleIn, legacyCaptionsIn, moveLegacyCaptions, savedQueriesIn, setOwn, styleIn, withAssignment, withLegacyCaptions } from './userDataStore';
import type { IAssignment } from './userDataStore';

// =============================================================================
// TYPES
// =============================================================================

/** A node's drawn size. */
export type LabelSize = 'S' | 'M' | 'L';

/** What a node shows inside its circle. */
export type BadgeMode = 'initials' | 'dot' | 'none';

/** A person's choices for one label (unset members follow the defaults). */
export interface ILabelStyle {
	/** Index into CHART_COLOR_VARS. */
	slot?: number;
	size?: LabelSize;
	badge?: BadgeMode;
	/** The caption: a property name, or one of graph/captions.ts' specials (`<id>`, `<label>`). */
	caption?: string;
}

/** A person's choices for one relationship type. */
export interface ITypeStyle {
	/** Index into CHART_COLOR_VARS. */
	slot?: number;
}

/** How one connection's labels and relationship types are drawn. */
export interface IConnectionStyle {
	/** Colour slot per label, given once when the label is first seen and kept, so adding labels never shifts colours. */
	assigned: Readonly<Record<string, number>>;
	labels: Readonly<Record<string, ILabelStyle>>;
	types: Readonly<Record<string, ITypeStyle>>;
}

/** A connection's style as a screen reads it: `ready` once its store has been read (until then draw neutral). */
export interface IStyleView {
	ready: boolean;
	style: IConnectionStyle;
}

/** The style of a connection nobody has styled (defined with the bags, which read it). */
export { EMPTY_STYLE };

/**
 * A change to a connection's style, field by field, merged into what is stored where it is stored (so two quick
 * edits never undo each other): `patch` sets the fields it names, `clear` removes the fields it names (all four
 * clear a label back to its defaults). `reset` clears every person's choice of the connection and keeps the colour
 * slots its labels were given.
 */
export type StyleEdit =
	| { kind: 'label'; label: string; patch?: Partial<ILabelStyle>; clear?: ReadonlyArray<keyof ILabelStyle> }
	| { kind: 'type'; type: string; patch?: Partial<ITypeStyle>; clear?: ReadonlyArray<keyof ITypeStyle> }
	| { kind: 'reset' };

/** One saved query. */
export interface ISavedQuery {
	id: string;
	name: string;
	cypher: string;
	/** Epoch ms. */
	savedAt: number;
}

/**
 * One connection's saved queries as a view shows them. `session`: kept for this session only (no store could be
 * used); `note` says why something is missing or refused, else null.
 */
export interface ISavedQueriesView {
	status: 'loading' | 'ready' | 'session' | 'error';
	queries: readonly ISavedQuery[];
	note: string | null;
}

/** A change to a connection's saved queries. */
export type SavedEdit = { action: 'save'; name: string; cypher: string } | { action: 'rename'; id: string; name: string } | { action: 'delete'; id: string };

/** Styles and saved queries, as every mount offers them. */
export interface IGraphUserData {
	/** One connection's style and whether its store was read (one stable readable per key). */
	style(key: string): IReadable<IStyleView>;
	/** Resolves once applied, rejects with the reason (an ExplorerToolError whose message is the sentence to show). */
	editStyle(key: string, edit: StyleEdit): Promise<void>;
	/** One connection's saved queries (one stable readable per key). */
	saved(key: string): IReadable<ISavedQueriesView>;
	/** Resolves once applied, rejects with the reason (an ExplorerToolError whose message is the sentence to show). */
	editSaved(key: string, edit: SavedEdit): Promise<void>;
	/** One true sentence: where styles and saved queries are kept on this mount, now ('' until a frame has been told). */
	readonly privacyNote: string;
}

// =============================================================================
// PURE EDITS
// =============================================================================

/** The fields a label style has. */
const LABEL_FIELDS: ReadonlyArray<keyof ILabelStyle> = ['slot', 'size', 'badge', 'caption'];

/**
 * Apply a style edit to a style (what the owning store does to what it holds; graph/userDataStore.ts applies the
 * same rule to the stored bag).
 *
 * @param style - The current style.
 * @param edit - The change.
 * @returns The new style (the same object when nothing changed).
 */
export function applyStyleEdit(style: IConnectionStyle, edit: StyleEdit): IConnectionStyle {
	switch (edit.kind) {
		case 'reset':
			return Object.keys(style.labels).length === 0 && Object.keys(style.types).length === 0 ? style : { assigned: style.assigned, labels: {}, types: {} };
		case 'label': {
			const next: Record<string, unknown> = { ...(Object.hasOwn(style.labels, edit.label) ? style.labels[edit.label] : {}), ...(edit.patch ?? {}) };
			for (const field of edit.clear ?? []) delete next[field];
			const labels: Record<string, ILabelStyle> = { ...style.labels };
			if (LABEL_FIELDS.some((field) => next[field] !== undefined)) setOwn(labels, edit.label, next as ILabelStyle);
			else delete labels[edit.label];
			return { ...style, labels };
		}
		case 'type': {
			const next: ITypeStyle = { ...(Object.hasOwn(style.types, edit.type) ? style.types[edit.type] : {}), ...(edit.patch ?? {}) };
			if (edit.clear?.includes('slot')) delete next.slot;
			const types: Record<string, ITypeStyle> = { ...style.types };
			if (next.slot !== undefined) setOwn(types, edit.type, next);
			else delete types[edit.type];
			return { ...style, types };
		}
	}
}

// =============================================================================
// PRIVACY NOTES (one true sentence per mount, from where things are kept now)
// =============================================================================

/** The note of a session-only store. */
export const SESSION_USER_DATA_NOTE = 'Kept for this session only: styles and saved queries are not saved anywhere.';

/** The full app's note: they ride the shell's workspace preferences. */
export const APP_USER_DATA_NOTE = 'Saved in your RocketRide workspace file on the server, for your account, not in this browser.';

/** Where one of the dev tool's files is: read and written, this session only (it could not be read), or nowhere (nobody signed in). */
export type UserDataStorage = 'file' | 'session' | 'none';

/**
 * The dev tool's note for where its controller keeps saved queries and styles (each in its own file).
 *
 * @param saved - Where the saved queries are kept.
 * @param styles - Where the styles are kept.
 * @returns The sentence.
 */
export function devToolUserDataNote(saved: UserDataStorage, styles: UserDataStorage = saved): string {
	if (saved === 'none' || styles === 'none') return 'Not saved: nobody is signed in to a RocketRide server.';
	if (saved === 'session' && styles === 'session') return 'Kept for this session only: your files in the user folder could not be read, so they are left alone.';
	if (saved === 'session') return 'Saved queries are kept for this session only: rocketride.graph.saved.json could not be read, so it is left alone.';
	if (styles === 'session') return 'Styles are kept for this session only: rocketride.graph.styles.json could not be read, so it is left alone.';
	return 'Saved on the server in your user folder (rocketride.graph.saved.json, rocketride.graph.styles.json), for your account; the last window to save wins.';
}

// =============================================================================
// THE STORED IMPLEMENTATION (over the accessors its sources hold)
// =============================================================================

/** Where reading stands on a mount, right now: an accessor to read through, or why there is none. */
export type UserDataRead = { status: 'ready' | 'session'; prefs: IPrefsAccessor } | { status: 'loading' | 'error'; note: string | null };

/** Where one of the two bags is kept. Its owner calls `notify()` on the user data whenever `read()` may answer differently. */
export interface IUserDataSource {
	/** Where reading stands now (synchronous). `session`: readable and changeable, but never written anywhere. */
	read(): UserDataRead;
	/**
	 * The accessor to read or change, once it can be (may wait, bounded).
	 *
	 * @param tool - What asks (named in errors).
	 * @returns The accessor.
	 * @throws ExplorerToolError when nobody may be served (nobody signed in, another account, not read in time).
	 */
	accessor(tool: string): Promise<IPrefsAccessor>;
	/** A change was made through the accessor. */
	changed?(): void;
}

/** Where a stored user data keeps its two bags, whose they are, and how it says so. */
export interface IUserDataSources {
	styles: IUserDataSource;
	saved: IUserDataSource;
	/**
	 * The account the bags belong to now (the identity fingerprint; null when nobody is signed in). Colour slots are
	 * computed for one account and written only while it is still the one signed in.
	 */
	owner(): string | null;
	/** Where they are kept, in one sentence, now. */
	privacyNote(): string;
}

/** One connection of the owning realm's schema store: its label list, and whether the read lists every label. */
export interface IWantedSchema {
	key: string;
	labels: readonly string[];
	/** Fresh and not truncated: a slot of a label it no longer lists may be released for a new one. */
	complete: boolean;
}

/** What {@link createStoredUserData} may be given besides its sources. */
export interface IStoredUserDataOptions {
	/** The clock (saved queries' ids and times). */
	now?: () => number;
	/** How long colour slots wait before they are written (a burst of schema loads is one write). */
	assignDelayMs?: number;
	/** Timers (tests run their own); returns a cancel. */
	schedule?: (fn: () => void, ms: number) => () => void;
	/**
	 * Told when the style a connection shows may have changed without a write (new colour slots shown before they are
	 * stored): the controller moves its styles revision, so frames read them now, not after the write.
	 */
	onShownChange?: () => void;
	/**
	 * Save the colour slots (and anything moved from an older format) only together with the next change the person
	 * makes in this page (`userWrote`), never by themselves. The full app: its page writes its whole preferences
	 * partition on any write, so merely opening a connection in an older page must not overwrite what another page saved.
	 */
	holdSlots?: boolean;
	/** The full app's older caption key (`graph.captions`): shown at once, moved into the styles once (held like the slots). */
	legacyCaptionsPref?: string;
}

/** A user data owned by a realm that holds its bags: the full app, the controller, or memory. */
export interface IOwnedUserData extends IGraphUserData {
	/**
	 * Change a style. `check` runs right before the write, after any wait (the controller re-checks the caller's
	 * account there).
	 */
	editStyle(key: string, edit: StyleEdit, check?: () => void): Promise<void>;
	/** Change the saved queries; `check` as for {@link editStyle}. */
	editSaved(key: string, edit: SavedEdit, check?: () => void): Promise<void>;
	/**
	 * Every connection of the owning realm's schema store, as it is now (it REPLACES what was wanted before, so a
	 * cleared store wants nothing): their colour slots are shown at once and written (debounced) once the styles store
	 * has been read, for the account they were computed for only.
	 */
	want(schemas: readonly IWantedSchema[]): void;
	/** The account changed (or is gone): forget what was wanted and drop the pending slot write. */
	forget(): void;
	/** The person made a change in this page: what is held (`holdSlots`) is saved with it, for the account signed in now. */
	userWrote(): void;
	/** Read again: a source's state, or the account, may have changed. */
	notify(): void;
	/** Be told about every change, of any connection. */
	subscribe(listener: () => void): () => void;
	/** Stop the pending slot write (the realm unmounts). */
	dispose(): void;
}

/** How long colour slots wait before they are written. */
export const ASSIGN_DELAY_MS = 1_000;

/** No saved queries (shared, so snapshots stay stable). */
const NO_QUERIES: readonly ISavedQuery[] = Object.freeze([]) as readonly ISavedQuery[];

/** The style views with nothing to say (shared, so snapshots stay stable). */
const STYLE_LOADING: IStyleView = Object.freeze({ ready: false, style: EMPTY_STYLE });
const STYLE_NONE: IStyleView = Object.freeze({ ready: true, style: EMPTY_STYLE });

/**
 * A view of one connection's saved queries, the same object while nothing in it changed.
 *
 * @param last - The previous view, or null.
 * @param next - The new one.
 * @returns `last` when equal, else `next`.
 */
function sameView(last: ISavedQueriesView | null, next: ISavedQueriesView): ISavedQueriesView {
	if (last && last.status === next.status && last.note === next.note && last.queries.length === next.queries.length && JSON.stringify(last.queries) === JSON.stringify(next.queries)) return last;
	return next;
}

/** Whether an assignment changes anything. */
const changes = (delta: IAssignment): boolean => Object.keys(delta.add).length > 0 || delta.release.length > 0;

let idCounter = 0;

/**
 * A saved query id: unique within a realm, and across realms in practice.
 *
 * @param now - The clock.
 * @returns The id.
 */
export function newSavedId(now: () => number = Date.now): string {
	idCounter += 1;
	return `q-${now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The default timers. */
const realTimers = (fn: () => void, ms: number): (() => void) => {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
};

/**
 * Styles and saved queries over two sources. Reads are synchronous and stable (one object per connection until it
 * changes); a change waits for its source, refuses past a bound with a sentence, and is told to every subscriber once
 * written.
 *
 * @param sources - Where the bags are.
 * @param opts - Clock and timers.
 * @returns The user data.
 */
export function createStoredUserData(sources: IUserDataSources, opts: IStoredUserDataOptions = {}): IOwnedUserData {
	const now = opts.now ?? Date.now;
	const schedule = opts.schedule ?? realTimers;
	const delay = opts.assignDelayMs ?? ASSIGN_DELAY_MS;
	const listeners = new Set<{ fn: () => void }>();
	const subscribe = (listener: () => void): (() => void) => {
		const entry = { fn: listener };
		listeners.add(entry);
		return () => {
			listeners.delete(entry);
		};
	};
	const notify = (): void => listeners.forEach((entry) => entry.fn());
	const styleReadables = new Map<string, IReadable<IStyleView>>();
	const savedReadables = new Map<string, IReadable<ISavedQueriesView>>();
	// What the owning realm's schema lists per connection (the slots come from these, never from a screen's labels),
	// and the account it was listed for: never anyone else's.
	let wanted = new Map<string, { labels: readonly string[]; complete: boolean }>();
	let wantedFor: string | null = null;
	// One view per key, with what it was made from: the same inputs (most hosts hand out the same objects) are not read
	// again, and equal text gives the same view, so a host that copies values still gives a stable snapshot.
	const styles = new Map<string, { stored: IConnectionStyle; want: unknown; legacy: unknown; text: string; view: IStyleView }>();
	const views = new Map<string, { raw: unknown; view: ISavedQueriesView }>();
	let cancelWrite: (() => void) | null = null;

	const styleOf = (key: string): IStyleView => {
		const read = sources.styles.read();
		if (!('prefs' in read)) return read.status === 'loading' ? STYLE_LOADING : STYLE_NONE;
		const stored = styleIn(read.prefs, key);
		const want = wantedFor === sources.owner() ? wanted.get(key) : undefined;
		const legacy = opts.legacyCaptionsPref ? read.prefs.getPref(opts.legacyCaptionsPref) : undefined;
		const last = styles.get(key);
		if (last && last.stored === stored && last.want === want && last.legacy === legacy) return last.view;
		const delta = want ? assignmentFor(stored.assigned, want.labels, want.complete) : null;
		const assigned = delta && changes(delta) ? withAssignment(stored, delta) : stored;
		const style = legacy === undefined ? assigned : withLegacyCaptions(assigned, legacyCaptionsIn(legacy, key));
		const text = JSON.stringify(style);
		const view = last && last.text === text ? last.view : { ready: true, style };
		styles.set(key, { stored, want, legacy, text, view });
		return view;
	};
	const savedOf = (key: string): ISavedQueriesView => {
		const read = sources.saved.read();
		const last = views.get(key) ?? null;
		const raw = 'prefs' in read ? read.prefs.getPref(SAVED_QUERIES_PREF) : null;
		if (last && last.raw === raw && last.view.status === read.status && raw !== null && raw !== undefined) return last.view;
		const next: ISavedQueriesView = 'prefs' in read ? { status: read.status, queries: savedQueriesIn(read.prefs, key), note: null } : { status: read.status, queries: NO_QUERIES, note: read.note };
		const view = sameView(last?.view ?? null, next);
		views.set(key, { raw, view });
		return view;
	};

	// The slots are written only to a styles store that was READ (never while it loads, never to a session-only
	// fallback: an automatic write must never replace what it has not seen), only when they change something, and only
	// for the account they were computed for, still the one signed in when the write is due. Older captions are moved
	// the same way (the full app), for the account signed in now. Returns whether anything was written.
	let writing = false;
	const writeHeld = (owner: string | null): boolean => {
		cancelWrite = null;
		const read = sources.styles.read();
		if (writing || read.status !== 'ready' || owner === null || owner !== sources.owner()) return false;
		// Writing through the page's preferences tells `userWrote` again: once is enough.
		writing = true;
		let wrote = false;
		try {
			if (opts.legacyCaptionsPref && moveLegacyCaptions(read.prefs, opts.legacyCaptionsPref)) wrote = true;
			if (owner === wantedFor) {
				for (const [key, want] of wanted) {
					const delta = assignmentFor(styleIn(read.prefs, key).assigned, want.labels, want.complete);
					if (changes(delta) && editStyleIn(read.prefs, key, { kind: 'assign', ...delta })) wrote = true;
				}
			}
		} finally {
			writing = false;
		}
		return wrote;
	};
	const writeSlots = (owner: string | null): void => {
		if (!writeHeld(owner)) return;
		notify();
		sources.styles.changed?.();
	};
	const scheduleSlots = (): void => {
		cancelWrite?.();
		// Held: saved only with the next change the person makes (userWrote).
		if (opts.holdSlots) return;
		const owner = wantedFor;
		cancelWrite = schedule(() => writeSlots(owner), delay);
	};

	return {
		get privacyNote() {
			return sources.privacyNote();
		},
		style(key) {
			let readable = styleReadables.get(key);
			if (!readable) {
				readable = { get: () => styleOf(key), subscribe };
				styleReadables.set(key, readable);
			}
			return readable;
		},
		saved(key) {
			let readable = savedReadables.get(key);
			if (!readable) {
				readable = { get: () => savedOf(key), subscribe };
				savedReadables.set(key, readable);
			}
			return readable;
		},
		async editStyle(key, edit, check) {
			const prefs = await sources.styles.accessor('styleEdit');
			check?.();
			// What is held goes first, so the person's edit is applied over it (a caption cleared stays cleared).
			const held = opts.holdSlots ? writeHeld(sources.owner()) : false;
			if (!editStyleIn(prefs, key, edit) && !held) return;
			notify();
			sources.styles.changed?.();
		},
		async editSaved(key, edit, check) {
			const prefs = await sources.saved.accessor('savedEdit');
			check?.();
			if (opts.holdSlots) writeHeld(sources.owner());
			editSavedIn(prefs, key, edit, { id: newSavedId(now), at: now() });
			notify();
			sources.saved.changed?.();
		},
		want(schemas) {
			const owner = sources.owner();
			const next = new Map<string, { labels: readonly string[]; complete: boolean }>();
			for (const schema of schemas) next.set(schema.key, { labels: Array.from(new Set(schema.labels)).filter((label) => label !== ''), complete: schema.complete });
			const same = owner === wantedFor && next.size === wanted.size && [...next].every(([key, want]) => {
				const last = wanted.get(key);
				return last !== undefined && last.complete === want.complete && last.labels.length === want.labels.length && last.labels.every((label, i) => label === want.labels[i]);
			});
			if (!same) {
				// Unchanged entries keep their object, so their cached view stays the same snapshot.
				for (const [key, want] of next) {
					const last = wanted.get(key);
					if (last && last.complete === want.complete && last.labels.length === want.labels.length && last.labels.every((label, i) => label === want.labels[i])) next.set(key, last);
				}
				wanted = next;
				wantedFor = owner;
				notify();
				opts.onShownChange?.();
			}
			if (wanted.size > 0 && sources.styles.read().status === 'ready') scheduleSlots();
		},
		userWrote() {
			if (opts.holdSlots) writeSlots(sources.owner());
		},
		forget() {
			cancelWrite?.();
			cancelWrite = null;
			if (wanted.size === 0 && wantedFor === null) return;
			wanted = new Map();
			wantedFor = null;
			notify();
			opts.onShownChange?.();
		},
		notify,
		subscribe,
		dispose() {
			cancelWrite?.();
			cancelWrite = null;
		},
	};
}

/**
 * Styles and saved queries kept in memory for this session. Colour slots are shown, never written anywhere.
 *
 * @param privacyNote - Where this mount keeps them (true for the mount).
 * @param now - The clock.
 * @returns The user data.
 */
export function createMemoryUserData(privacyNote: string, now: () => number = Date.now): IOwnedUserData {
	const values = new Map<string, unknown>();
	const prefs: IPrefsAccessor = { getPref: (key) => values.get(key), setPref: (key, value) => void values.set(key, value) };
	const source: IUserDataSource = { read: () => ({ status: 'session', prefs }), accessor: async () => prefs };
	return createStoredUserData({ styles: source, saved: source, owner: () => 'session', privacyNote: () => privacyNote }, { now });
}

/**
 * Give every loaded schema's labels their colour slots, in the realm that owns the schema: now, on every schema
 * change, and whenever the user data can be written again (a file read, an account back). What is wanted is rebuilt
 * from the schema store each time, so a store cleared for another account wants nothing of the previous one.
 *
 * @param schemas - The realm's schema store.
 * @param userData - The realm's user data.
 * @returns Stop following.
 */
export function followAssignments(schemas: ISchemaStore, userData: IOwnedUserData): () => void {
	let running = false;
	const run = (): void => {
		// A change notifies, which runs this again: once is enough (it finds nothing new).
		if (running) return;
		running = true;
		try {
			const wanted: IWantedSchema[] = [];
			for (const key of schemas.keys()) {
				const entry = schemas.get(key);
				if (entry.loadedAt === 0 || entry.view.labels.length === 0) continue;
				wanted.push({ key, labels: entry.view.labels.map((label) => label.name), complete: entry.view.evidence === 'fresh' && !entry.view.truncated });
			}
			userData.want(wanted);
		} finally {
			running = false;
		}
	};
	const offSchemas = schemas.subscribe(run);
	const offData = userData.subscribe(run);
	run();
	return () => {
		offSchemas();
		offData();
	};
}
