// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The only writer of a chat's rows and of its one turn. It has no React, so tests drive it directly;
 * `useChatMessages` is a `useSyncExternalStore` adapter over it. One turn runs at a time; a send
 * during a turn becomes a queued row the running request may take, else it opens the next turn.
 * It also owns the turn's "Needs your OK" cards (`ChatTurn.ask`): not rows, never saved, and ended
 * as not answered by Stop, the turn settling or a clear, so no card outlives its turn.
 */

import type { ChatAskAnswer, ChatAskCard, ChatAsking, ChatAskView, ChatMessage, ChatStatusSink, ChatTurn, ChatTurnPhase, ChatTurnView, TextResult } from '../types';
import { makeStatusSink, statusRow } from '../hooks/statusRows';

// =============================================================================
// TYPES
// =============================================================================

/** How long a stopped request has to settle before the controller closes its turn without it. */
export const STOP_GRACE_MS = 3_000;

/** The `sseType` of the row an answered card leaves. Not 'thinking', so it shows on its own, outside the Thinking fold. */
export const ASK_ROW_TYPE = 'approval';

/** The request one turn runs. v0's optional-argument `request` fits it as it is. */
export type ChatRequest = (text: string, onStatus: ChatStatusSink, turn: ChatTurn) => Promise<TextResult[]>;

/** Options for a TurnController. */
export interface TurnControllerOptions {
	/** The saved conversation to start from. */
	initialMessages?: ChatMessage[];
	/** The request for a turn, read when the turn begins, so the host's latest one runs. */
	request: () => ChatRequest;
	/** The formatted time for new rows (default: the local hour and minute, as v0). */
	now?: () => string;
	/** Overrides STOP_GRACE_MS; tests pass 0. */
	stopGraceMs?: number;
}

/** What subscribers read: a new object on every change, the same one otherwise. */
export interface ChatSnapshot {
	readonly messages: ChatMessage[];
	readonly phase: ChatTurnPhase;
	readonly returned: ChatTurnView['returned'];
	/** The running turn's waiting cards, oldest first; [] when none. */
	readonly asks: readonly ChatAskView[];
}

/** The turn in the slot. */
interface LiveTurn {
	readonly abort: AbortController;
	/** The id of the turn's opening user row; the turn's progress rows are the status rows from it on. */
	readonly openingId: number;
}

/** A card waiting in a turn. */
interface WaitingAsk {
	readonly id: number;
	readonly turn: LiveTurn;
	readonly card: ChatAskCard;
	readonly resolve: (answer: ChatAskAnswer) => void;
}

/** The one turn slot. "Stopping without a turn" cannot be written. */
type Slot = { phase: 'idle' } | { phase: 'running'; turn: LiveTurn } | { phase: 'stopping'; turn: LiveTurn; grace: ReturnType<typeof setTimeout> };

/** How a turn's request ended; `cut` is the grace timer closing a stopped turn. */
type Settled = { kind: 'answered'; answers: TextResult[] } | { kind: 'failed'; error: unknown } | { kind: 'cut' };

// =============================================================================
// CONTROLLER
// =============================================================================

/** One chat's rows and its single turn slot. */
export class TurnController {
	private slot: Slot = { phase: 'idle' };
	private rows: ChatMessage[];
	private returned: ChatTurnView['returned'] = null;
	/** The waiting cards, oldest first; every one belongs to the turn in the slot. */
	private asks: WaitingAsk[] = [];
	/** The cards as the snapshot shows them, rebuilt only when the cards change. */
	private askViews: readonly ChatAskView[] = [];
	private snap: ChatSnapshot;
	private nextId: number;
	private readonly now: () => string;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly o: TurnControllerOptions) {
		const initial = o.initialMessages ?? [];
		// aparavi saves user rows as they are, so a row queued at save time comes back flagged
		this.rows = initial.some((row) => row.queued) ? initial.map(unqueued) : initial;
		// ids continue past the restored ones: Edit and Remove address rows by id
		this.nextId = this.rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
		this.now = o.now ?? clockTime;
		this.snap = { messages: this.rows, phase: 'idle', returned: null, asks: this.askViews };
	}

	/** Adds a change listener; returns its unsubscribe. */
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The current rows, phase and hand-back. */
	readonly snapshot = (): ChatSnapshot => this.snap;

	/** Sends a user message: it opens a turn when the chat is idle, and queues otherwise. */
	send(text: string): void {
		if (!text.trim()) return;
		const row = this.userRow(text);
		if (this.slot.phase === 'idle') {
			this.rows = [...this.rows, row];
			this.begin(row);
			return;
		}
		this.rows = [...this.rows, { ...row, queued: true }];
		this.publish();
	}

	/** Stops the running turn: aborts its signal and hands every queued message back to the composer. */
	stop(): void {
		if (this.slot.phase !== 'running') return;
		const { turn } = this.slot;
		const queued = this.rows.filter((row) => row.queued);
		if (queued.length) {
			this.rows = this.rows.filter((row) => !row.queued);
			this.returned = { id: this.mint(), text: queued.map((row) => row.text).join('\n\n') };
		}
		const grace = setTimeout(() => this.settle(turn, { kind: 'cut' }), this.o.stopGraceMs ?? STOP_GRACE_MS);
		this.slot = { phase: 'stopping', turn, grace };
		// before the abort: the request hears 'stopped' for each card, so it starts nothing
		this.closeAsks(turn, true);
		// after the slot moves: an abort listener that runs at once must already see a stopping turn
		turn.abort.abort();
		this.publish();
	}

	/**
	 * Answers a waiting card: it leaves the bottom of the thread, its row goes
	 * into the thread (before any queued row), and the request hears the
	 * answer. An id that no longer waits does nothing.
	 *
	 * @param id - The card's id, from the snapshot.
	 * @param answer - The button the user pressed, or the request's own approve().
	 */
	answerAsk(id: number, answer: Exclude<ChatAskAnswer, 'stopped'>): void {
		const ask = this.asks.find((a) => a.id === id);
		if (!ask) return;
		this.setAsks(this.asks.filter((a) => a !== ask));
		this.insert(statusRow(this.mint(), ASK_ROW_TYPE, answeredLine(ask.card, answer), this.now()));
		ask.resolve(answer);
		this.publish();
	}

	/** Takes a queued message out and hands its text back to the composer. */
	editQueued(id: number): void {
		const row = this.dequeue(id);
		if (!row) return;
		this.returned = { id: this.mint(), text: row.text };
		this.publish();
	}

	/** Takes a queued message out. */
	removeQueued(id: number): void {
		if (this.dequeue(id)) this.publish();
	}

	/** Adds a system row. */
	addSystemMessage(text: string): void {
		this.insert(this.systemRow(text));
		this.publish();
	}

	/** Drops any turn without a closing row and leaves only the welcome row. */
	clear(welcome: string): void {
		if (this.slot.phase !== 'idle') {
			const { turn } = this.slot;
			if (this.slot.phase === 'stopping') clearTimeout(this.slot.grace);
			this.slot = { phase: 'idle' };
			this.closeAsks(turn, false);
			turn.abort.abort();
		}
		this.rows = [this.systemRow(welcome)];
		this.publish();
	}

	/** Opens a turn on a user row that is already in the list and not queued. */
	private begin(opening: ChatMessage): void {
		const turn: LiveTurn = { abort: new AbortController(), openingId: opening.id };
		this.slot = { phase: 'running', turn };
		const sink = makeStatusSink(
			(row) => {
				if (!this.holds(turn)) return;
				this.insert(row);
				this.publish();
			},
			() => this.mint(),
			this.now
		);
		const handle: ChatTurn = {
			history: this.rows.slice(0, this.rows.indexOf(opening)),
			signal: turn.abort.signal,
			takeQueued: () => (this.slot.phase === 'running' && this.slot.turn === turn ? this.takeQueued() : []),
			ask: (card) => this.ask(turn, card),
		};
		this.publish();
		new Promise<TextResult[]>((resolve) => resolve(this.o.request()(opening.text, sink, handle))).then(
			(answers) => this.settle(turn, { kind: 'answered', answers }),
			(error: unknown) => this.settle(turn, { kind: 'failed', error })
		);
	}

	/** Hands every queued message to the running turn, oldest first. */
	private takeQueued(): string[] {
		const taken = this.rows.filter((row) => row.queued);
		if (!taken.length) return [];
		this.rows = this.rows.map((row) => (row.queued ? unqueued(row) : row));
		this.publish();
		return taken.map((row) => row.text);
	}

	/**
	 * Puts a card up for a turn. A turn that no longer runs gets no card and
	 * an answer of 'stopped' at once, so a request still going after Stop can
	 * never get anything approved.
	 */
	private ask(turn: LiveTurn, card: ChatAskCard): ChatAsking {
		if (this.slot.phase !== 'running' || this.slot.turn !== turn) return { answer: Promise.resolve('stopped'), approve: () => undefined };
		const id = this.mint();
		let resolve: (answer: ChatAskAnswer) => void = () => undefined;
		const answer = new Promise<ChatAskAnswer>((settle) => {
			resolve = settle;
		});
		this.setAsks([...this.asks, { id, turn, card, resolve }]);
		this.publish();
		return { answer, approve: () => this.answerAsk(id, 'approve') };
	}

	/**
	 * Ends every card of a turn as not answered.
	 *
	 * @param withRows - Whether each leaves its "Not answered" row (not on a clear, which resets the rows).
	 */
	private closeAsks(turn: LiveTurn, withRows: boolean): void {
		const ending = this.asks.filter((a) => a.turn === turn);
		if (!ending.length) return;
		this.setAsks(this.asks.filter((a) => a.turn !== turn));
		for (const ask of ending) {
			if (withRows) this.insert(statusRow(this.mint(), ASK_ROW_TYPE, answeredLine(ask.card, 'stopped'), this.now()));
			ask.resolve('stopped');
		}
	}

	/** Replaces the waiting cards and the views the snapshot shows. */
	private setAsks(next: WaitingAsk[]): void {
		this.asks = next;
		this.askViews = next.map(({ id, card }) => ({ id, card }));
	}

	/** Closes a turn with its answer, its error, or (when stopping) the stop row, then opens the next queued one. */
	private settle(turn: LiveTurn, how: Settled): void {
		if (this.slot.phase === 'idle' || this.slot.turn !== turn) return;
		// a request that ends with a card still up never hears an answer for it
		this.closeAsks(turn, true);
		if (this.slot.phase === 'stopping') {
			clearTimeout(this.slot.grace);
			this.insert(closingRow(this.progressOf(turn), this.mint(), this.now()));
		} else if (how.kind === 'answered') {
			for (const a of how.answers) {
				this.insert({ id: this.mint(), text: a.text, sender: 'bot', timestamp: this.now(), ...(a.key ? { resultKey: a.key } : {}) });
			}
		} else if (how.kind === 'failed') {
			const text = how.error instanceof Error ? how.error.message : 'An unexpected error occurred. Please try again.';
			this.insert({ id: this.mint(), text, sender: 'bot', isError: true, timestamp: this.now() });
		}
		this.slot = { phase: 'idle' };
		const next = this.rows.find((row) => row.queued);
		if (!next) {
			this.publish();
			return;
		}
		const opening = unqueued(next);
		this.rows = this.rows.map((row) => (row === next ? opening : row));
		this.begin(opening);
	}

	private holds(turn: LiveTurn): boolean {
		return this.slot.phase !== 'idle' && this.slot.turn === turn;
	}

	/** Removes a queued row and returns it; undefined when the id is not a queued row. */
	private dequeue(id: number): ChatMessage | undefined {
		const row = this.rows.find((r) => r.id === id);
		if (!row?.queued) return undefined;
		this.rows = this.rows.filter((r) => r !== row);
		return row;
	}

	/** Puts a row just before the first queued row, or at the end, so queued rows stay last. */
	private insert(row: ChatMessage): void {
		const at = this.rows.findIndex((r) => r.queued);
		this.rows = at < 0 ? [...this.rows, row] : [...this.rows.slice(0, at), row, ...this.rows.slice(at)];
	}

	/** The status rows from the turn's opening row to the end. */
	private progressOf(turn: LiveTurn): ChatMessage[] {
		const start = this.rows.findIndex((row) => row.id === turn.openingId);
		return start < 0 ? [] : this.rows.slice(start).filter((row) => row.sender === 'status');
	}

	/** Replaces the snapshot and tells every subscriber. */
	private publish(): void {
		this.snap = { messages: this.rows, phase: this.slot.phase, returned: this.returned, asks: this.askViews };
		for (const listener of this.listeners) listener();
	}

	/** A fresh row id. */
	private mint(): number {
		return this.nextId++;
	}

	private userRow(text: string): ChatMessage {
		return { id: this.mint(), text, sender: 'user', timestamp: this.now() };
	}

	private systemRow(text: string): ChatMessage {
		return { id: this.mint(), text, sender: 'system', timestamp: this.now() };
	}
}

// =============================================================================
// ROWS
// =============================================================================

/** A copy of the row without its queued flag. */
function unqueued(row: ChatMessage): ChatMessage {
	const copy = { ...row };
	delete copy.queued;
	return copy;
}

/** v0's row time: the local hour and minute. */
function clockTime(): string {
	return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The one row a card leaves. It is a status row, so it lands in the Stop
 * row's "Progress before the stop", which the model reads next turn.
 */
function answeredLine(card: ChatAskCard, answer: ChatAskAnswer): string {
	switch (answer) {
		case 'approve':
			return `Approved: ${card.title}`;
		case 'always':
			return `Approved: ${card.title} (always allowed from now on)`;
		case 'deny':
			return `Denied: ${card.title}`;
		case 'stopped':
			return `Not answered: ${card.title}. The run ended first, so nothing was done.`;
	}
}

/** The bot row that closes a stopped turn; its text is what the model reads as its last answer next turn. */
function closingRow(progress: ChatMessage[], id: number, timestamp: string): ChatMessage {
	const parts = ['Stopped by you.'];
	if (progress.length) parts.push('Progress before the stop:', ...progress.map((row) => row.text));
	return { id, text: parts.join('\n\n'), sender: 'bot', timestamp };
}
