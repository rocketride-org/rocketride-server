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
// GRAPH-UI - USER DATA: A FRAME'S VIEW OF THE CONTROLLER'S
// =============================================================================
//
// Ported from sql-ui (history/remoteSavedQueries.ts). In a dev tool the
// controller owns label styles and saved queries (devtool/controller.ts,
// graph/userDataFile.ts). A frame:
//
//   reads    a connection's styles with `graph.styles` and its saved queries
//            with `graph.savedQueries` (op results, which also say where they
//            are kept), each on first use and again whenever its own
//            revision in the retained `userData` topic moves on (another
//            document changed it, its file was read, the account changed, a
//            colour slot was given): a colour slot never makes a frame read
//            the saved queries again;
//   writes   through `graph.styleEdit` and `graph.savedEdit` only, carrying
//            the account the frame belongs to; the controller refuses a change
//            for anyone else, and a refusal (a cap, a query gone) reaches the
//            caller. A style edit is field by field, merged in the
//            controller, so two quick edits never undo each other.
//
// THE LATEST READ WINS. Every read is sent (none waits for another in flight)
// and only the answer to the newest one is used: a read that is never
// answered (its controller went away) cannot hold back the next, and an older
// answer that arrives late cannot replace a newer one. Until the first answer
// the saved queries read as loading and the style as not ready; a failed read
// says why (the style then reads as ready and empty, rather than neutral for
// ever), and the next revision (or identity) reads again. Nothing is read
// before the frame knows its account.
// =============================================================================

import type { ToolChannel } from 'shell';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import type { IReadable } from '../env';
import { EMPTY_STYLE } from '../graph/userData';
import type { IConnectionStyle, IGraphUserData, ISavedQueriesView, IStyleView, SavedEdit, StyleEdit } from '../graph/userData';
import { OP, STATE, field, frameTimeoutFor, toWire } from './protocol';
import type { GraphOps } from './protocol';

/** A frame's user data, with its lifetime. */
export interface IRemoteUserData extends IGraphUserData {
	/** Forget everything read (an identity reset), and read again what is watched. */
	reset(): void;
	/** Read again what is watched and not current (the host connection is back). */
	retry(): void;
	/** Stop following the channel. */
	dispose(): void;
}

/** What {@link createRemoteUserData} needs. */
export interface IRemoteUserDataOptions {
	caller: IFrameCaller<GraphOps>;
	channel: ToolChannel;
	/** The fingerprint of the account the frame belongs to (null before it is known). */
	owner(): string | null;
	/** Whether the host connection is up (nothing is read while it is not). */
	connected(): boolean;
}

/** Shared views, so snapshots stay stable. */
const SAVED_LOADING: ISavedQueriesView = Object.freeze({ status: 'loading', queries: Object.freeze([]), note: null }) as ISavedQueriesView;
const STYLE_LOADING: IStyleView = Object.freeze({ ready: false, style: EMPTY_STYLE });

/** One kind of thing a frame reads (styles, or saved queries): its op, its revision and how to read its answer. */
interface IPart<T> {
	op: typeof OP.styles | typeof OP.savedQueries;
	rev: 'styleRev' | 'savedRev';
	initial: T;
	/** The value an answer carries, and where things are kept. */
	read(value: unknown): { value: T; note: string };
	/** What a failed read shows. */
	failed(last: T, message: string): T;
	/** Whether a value should be read again even though its revision did not move. */
	retry(value: T): boolean;
}

/** What the view holds for one connection and one part. */
interface ISlot<T> {
	value: T;
	/** The revision the last answer was for (null: not read yet). */
	rev: number | null;
	/** The newest read sent: only its answer is used. */
	seq: number;
	watchers: number;
	readable: IReadable<T>;
}

/**
 * Read a style answer that crossed the channel.
 *
 * @param value - The op's value.
 * @returns The view and the note.
 */
function asStyle(value: unknown): { value: IStyleView; note: string } {
	const style = field(value, 'style');
	const note = field(value, 'privacyNote');
	return {
		value: { ready: field(value, 'ready') !== false, style: style !== null && typeof style === 'object' ? (style as IConnectionStyle) : EMPTY_STYLE },
		note: typeof note === 'string' ? note : '',
	};
}

/**
 * Read a saved-queries answer that crossed the channel.
 *
 * @param value - The op's value.
 * @returns The view and the note.
 */
function asSaved(value: unknown): { value: ISavedQueriesView; note: string } {
	const saved = field(value, 'saved');
	const queries = field(saved, 'queries');
	const status = field(saved, 'status');
	const note = field(value, 'privacyNote');
	return {
		value: {
			status: status === 'ready' || status === 'session' || status === 'loading' || status === 'error' ? status : 'error',
			queries: Array.isArray(queries) ? (queries as ISavedQueriesView['queries']) : [],
			note: typeof field(saved, 'note') === 'string' ? (field(saved, 'note') as string) : null,
		},
		note: typeof note === 'string' ? note : '',
	};
}

const STYLES: IPart<IStyleView> = {
	op: OP.styles,
	rev: 'styleRev',
	initial: STYLE_LOADING,
	read: asStyle,
	// A style that cannot be read is drawn as nobody's, not neutral for ever.
	failed: () => ({ ready: true, style: EMPTY_STYLE }),
	retry: (value) => !value.ready,
};

const SAVED: IPart<ISavedQueriesView> = {
	op: OP.savedQueries,
	rev: 'savedRev',
	initial: SAVED_LOADING,
	read: asSaved,
	failed: (last, message) => ({ status: 'error', queries: last.queries, note: message }),
	retry: (value) => value.status === 'error' || value.status === 'loading',
};

/**
 * Build a frame's user data over its controller.
 *
 * @param opts - See {@link IRemoteUserDataOptions}.
 * @returns The user data; dispose it with the frame.
 */
export function createRemoteUserData(opts: IRemoteUserDataOptions): IRemoteUserData {
	const { caller, channel } = opts;
	// One entry per subscription, so the same function subscribed twice is told (and removed) per subscription.
	const listeners = new Set<{ fn: () => void }>();
	const revs: Record<'styleRev' | 'savedRev', number | null> = { styleRev: null, savedRev: null };
	let epoch = 0;
	let note = '';
	const notify = (): void => listeners.forEach((entry) => entry.fn());

	/** The slots of one part, and how to read one connection of it. */
	const follow = <T>(part: IPart<T>) => {
		const slots = new Map<string, ISlot<T>>();
		const fetch = (key: string): void => {
			const slot = slots.get(key);
			// Not before the frame knows its account (the identity topic reads again then): the controller would refuse it.
			if (!slot || !opts.connected() || opts.owner() === null) return;
			slot.seq += 1;
			const seq = slot.seq;
			const asked = epoch;
			const askedRev = revs[part.rev];
			const current = (): boolean => asked === epoch && slots.get(key) === slot && seq === slot.seq;
			caller.callReply(part.op, { key, owner: opts.owner() }, { timeoutMs: frameTimeoutFor(part.op) }).then(
				(answer) => {
					if (!current()) return;
					const read = part.read(answer);
					slot.value = read.value;
					slot.rev = askedRev;
					note = read.note;
					notify();
				},
				(error: unknown) => {
					if (!current()) return;
					slot.value = part.failed(slot.value, error instanceof Error ? error.message : String(error));
					notify();
				},
			);
		};
		const refetch = (all: boolean): void => {
			for (const [key, slot] of slots) if (slot.watchers > 0 && (all || slot.rev !== revs[part.rev] || part.retry(slot.value))) fetch(key);
		};
		const slotOf = (key: string): ISlot<T> => {
			let slot = slots.get(key);
			if (!slot) {
				const created: ISlot<T> = {
					value: part.initial,
					rev: null,
					seq: 0,
					watchers: 0,
					readable: {
						get: () => created.value,
						subscribe: (listener) => {
							const entry = { fn: listener };
							listeners.add(entry);
							created.watchers += 1;
							// Watched again: read it unless it is current (it may have changed while nobody watched it).
							if (created.watchers === 1 && (created.rev === null || created.rev !== revs[part.rev] || part.retry(created.value))) fetch(key);
							return () => {
								if (listeners.delete(entry)) created.watchers -= 1;
							};
						},
					},
				};
				slot = created;
				slots.set(key, slot);
			}
			return slot;
		};
		const reset = (): void => {
			for (const slot of slots.values()) {
				slot.value = part.initial;
				slot.rev = null;
			}
		};
		return { fetch, refetch, slotOf, reset };
	};
	const styles = follow(STYLES);
	const saved = follow(SAVED);

	const offRev = channel.onState(STATE.userData, (snapshot) => {
		const styleRev = field(snapshot, 'styleRev');
		const savedRev = field(snapshot, 'savedRev');
		if (typeof styleRev === 'number' && styleRev !== revs.styleRev) {
			revs.styleRev = styleRev;
			styles.refetch(false);
		}
		if (typeof savedRev === 'number' && savedRev !== revs.savedRev) {
			revs.savedRev = savedRev;
			saved.refetch(false);
		}
	});
	// A read held back because the frame had not yet learnt its account is sent once the controller vouches for one
	// (after this tick, so the frame's identity guard has taken it first).
	const offIdentity = channel.onState(STATE.identity, (snapshot) => {
		const fingerprint = field(snapshot, 'fingerprint');
		if (typeof fingerprint !== 'string' || fingerprint === '') return;
		queueMicrotask(() => {
			styles.refetch(false);
			saved.refetch(false);
		});
	});

	// Each change is sent, then that part is read again; a refusal reaches the caller.
	const editStyle = async (key: string, change: StyleEdit): Promise<void> => {
		await caller.callReply(OP.styleEdit, toWire({ key, owner: opts.owner(), edit: change }), { timeoutMs: frameTimeoutFor(OP.styleEdit) });
		styles.fetch(key);
	};
	const editSaved = async (key: string, change: SavedEdit): Promise<void> => {
		await caller.callReply(OP.savedEdit, toWire({ key, owner: opts.owner(), edit: change }), { timeoutMs: frameTimeoutFor(OP.savedEdit) });
		saved.fetch(key);
	};

	return {
		// Nothing until the controller has said where they are kept (never a guess).
		get privacyNote() {
			return note;
		},
		style: (key) => styles.slotOf(key).readable,
		saved: (key) => saved.slotOf(key).readable,
		editStyle,
		editSaved,
		retry() {
			styles.refetch(false);
			saved.refetch(false);
		},
		reset() {
			epoch += 1;
			note = '';
			styles.reset();
			saved.reset();
			notify();
			styles.refetch(true);
			saved.refetch(true);
		},
		dispose() {
			offRev();
			offIdentity();
			epoch += 1;
			listeners.clear();
		},
	};
}
