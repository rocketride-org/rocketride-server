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
// TURN — how one agent turn ended, and the card the chat shows for it
// =============================================================================

/**
 * Every turn ends with one TurnResult. The session file keeps it linked to the turn's bot row, and the chat
 * shows it as the card under that row (`turnCard`), so a reload shows the same card. Its text has passed
 * through `redactDeep`.
 */

import type { ChatCard } from 'shell/src/components/chat/types';

import { redactText } from './toolkits/common';
import { costText, tokensText } from './usage';

// =============================================================================
// TYPES
// =============================================================================

/** How a turn ended. */
export type TurnOutcome = 'done' | 'needs_input' | 'stopped' | 'failed' | 'incomplete';

/**
 * Why, in one word: the loop's stop reason ('done', 'needs_input',
 * 'empty_plan', 'error', 'stopped', 'limited' at the step limit, 'cost_limit'
 * when the cost limit refused a model request), 'unmounted' for a turn the
 * Agent tab closed on, or 'refused' for a message the session would not run.
 */
export type TurnReason = 'done' | 'needs_input' | 'empty_plan' | 'error' | 'stopped' | 'limited' | 'cost_limit' | 'unmounted' | 'refused';

/** One file the turn changed. */
export interface TurnFile {
	/** The workspace path; for a rename, where the file is now. */
	path: string;
	change: 'added' | 'modified' | 'deleted' | 'renamed';
	/** Where a renamed file came from. */
	from?: string;
}

/** One check result: a check_app step on an app, or the validate of a pipeline's latest save. */
export interface TurnCheck {
	/** The app's id (or folder), or the pipeline's path. */
	target: string;
	/** The step: 'manifest', 'types', 'build', 'console', 'validate', or 'check_app' for an app changed and never checked. */
	step: string;
	/** Passed, failed, or did not run. A step that did not run never counts as a pass. */
	status: 'pass' | 'fail' | 'not_run';
	/** What the check said, in a few words ("validate OK", "types: 2 errors"). */
	summary: string;
}

/** What the turn used. The step limit counts waves, and the cost limit the cost; the rest is for diagnostics. */
export interface TurnUsage {
	/** Waves run, counting the one the turn ended in. */
	waves: number;
	/** Model requests sent, retries and the best-effort answer included. */
	modelRequests: number;
	/** Tool calls the model planned. */
	toolCalls: number;
	/** The tokens, when something counts them; `estimated` when they come from character counts rather than the provider. */
	tokens?: { input: number; output: number; estimated: boolean };
	/** The cost, when the model has a price; `estimated` when it comes from character counts rather than the provider. */
	cost?: { usd: number; estimated: boolean };
}

/**
 * What a needs_input turn asks of the user. `question` and `variable` come
 * from ask_user; `continue` is the kind a turn paused by a limit uses.
 */
export interface NeedsInputRequest {
	/** A short id; the reply that answers it says "(answering request <id>)" to the model. */
	id: string;
	kind: 'question' | 'variable' | 'continue';
	/** What the user is asked, as the turn's answer shows it. */
	question: string;
	/** For a question: the answers offered, each a button that sends it. */
	choices?: string[];
	/** For a variable: its name (ROCKETRIDE_...). */
	variable?: string;
	/** For a variable: whether its name is among the account's Variables when asked. Unset when that could not be read. */
	variableSet?: boolean;
	/** The id of the turn whose user message answered it. Unset while it is open. */
	answeredBy?: string;
}

/**
 * A run this conversation started with `use`: the engine said it was not a
 * reused run, and a status read right after gave its start time. Only these
 * runs are the conversation's own.
 */
export interface RunRecord {
	token: string;
	projectId: string;
	source: string;
	/** The engine's startTime for it (Unix seconds). A later run on the same token starts at another time. */
	startTime: number;
	/** The workspace scope it was started in ('' for the user's own files). */
	scopeKey: string;
	/** The conversation (session id) that started it. */
	conversationId: string;
}

/** How one turn ended. */
export interface TurnResult {
	turnId: string;
	/** The id of the chat row that closes the turn (its answer, its error, or the stop row), once the session has linked it. */
	messageId?: number;
	/** The workspace scope the turn ran in ('' for the user's own files); unset on hosts with one scope. */
	scopeKey?: string;
	outcome: TurnOutcome;
	reason: TurnReason;
	/** The answer as the user reads it, checks line included; '' for a stopped or refused turn. */
	finalText: string;
	/** Why a failed turn failed, when it threw. */
	error?: string;
	/** What the turn changed, in the order first changed. */
	files: TurnFile[];
	/** The newest result per check target and step. */
	checks: TurnCheck[];
	usage: TurnUsage;
	/** What a needs_input turn asks. */
	request?: NeedsInputRequest;
	/** The runs this turn started that the conversation owns. */
	runsStarted?: RunRecord[];
	/** Whether the turn's file changes could be undone when it ended; unset for a turn that changed no file. */
	undoAvailable?: boolean;
}

/** A turn as the session file keeps it: always linked to its row. */
export type TurnRecord = TurnResult & { messageId: number };

// =============================================================================
// OUTCOMES
// =============================================================================

/**
 * The outcome a loop stop reason stands for.
 *
 * @returns done when the finish rule accepted the answer; needs_input when ask_user ended the turn or a limit paused it; stopped for Stop; failed when the model could not be reached; incomplete when its replies stayed unusable.
 */
export function outcomeOf(reason: 'done' | 'needs_input' | 'empty_plan' | 'error' | 'stopped' | 'limited' | 'cost_limit'): TurnOutcome {
	switch (reason) {
		case 'done':
			return 'done';
		case 'needs_input':
		case 'limited':
		case 'cost_limit':
			return 'needs_input';
		case 'stopped':
			return 'stopped';
		case 'error':
			return 'failed';
		case 'empty_plan':
			return 'incomplete';
	}
}

/**
 * The result of a turn that threw before it could build its own: a refused
 * message, or a model that failed before the run gathered anything.
 */
export function failedTurn(turnId: string, error: unknown, refused: boolean, scopeKey?: string): TurnResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		turnId,
		...(scopeKey !== undefined ? { scopeKey } : {}),
		outcome: 'failed',
		reason: refused ? 'refused' : 'error',
		finalText: '',
		error: redactText(message),
		files: [],
		checks: [],
		usage: { waves: 0, modelRequests: 0, toolCalls: 0 },
	};
}

/** A thrown turn: the error the chat shows, with the result the turn got as far as. */
export class TurnError extends Error {
	/**
	 * @param message - What the chat shows.
	 */
	constructor(
		message: string,
		readonly turn: TurnResult
	) {
		super(message);
		this.name = 'TurnError';
	}
}

// =============================================================================
// THE CARD
// =============================================================================

/** The button that opens the Variables overlay. */
export const OPEN_VARIABLES = 'open-variables';

/** The button that answers a continue request. */
export const CONTINUE = 'continue';

/** The text the Continue button sends. */
export const CONTINUE_TEXT = 'Continue.';

/** The button that undoes the latest turn's file changes. */
export const UNDO = 'undo';

/** The card line under a paused turn: what Continue does. */
const FRESH_BUDGET = 'Continue starts a new turn with a fresh budget.';

/** The id of the button for a question's choice. */
export function choiceAction(index: number): string {
	return `choice:${index}`;
}

/**
 * The card the chat shows under a turn's row, for every outcome:
 *
 * - done: "Done", the changed files and every check.
 * - failed and incomplete: "Not finished", the failing checks or the error.
 * - needs_input: "Needs you", with a button per choice, Open Variables for a
 *   variable, or Continue. An answered request's buttons are disabled. A turn
 *   a limit paused says so in its title ("Paused after 60 steps").
 * - stopped: "Stopped", the files changed so far.
 *
 * Files the turn left in place are links; deleted ones are lines. A turn
 * whose model has no price says so, since the cost limit does not apply.
 */
export function turnCard(turn: TurnResult): ChatCard {
	const files = turn.files.filter((f) => f.change !== 'deleted').map((f) => f.path);
	const deleted = turn.files.filter((f) => f.change === 'deleted').map((f) => `Deleted ${f.path}`);
	const checkLine = (c: TurnCheck): string => `${c.target}: ${c.summary || c.status.replace('_', ' ')}`;
	const unpriced = turn.usage.tokens && !turn.usage.cost ? [`No price for this model, so the cost limit does not apply (${tokensText(turn.usage.tokens.input + turn.usage.tokens.output)}).`] : [];
	const withFiles = ({ lines: own = [], ...card }: ChatCard): ChatCard => {
		const lines = [...own, ...deleted, ...unpriced];
		return { ...card, ...(lines.length ? { lines } : {}), ...(files.length ? { files } : {}) };
	};
	switch (turn.outcome) {
		case 'done':
			return withFiles({ tone: 'success', title: 'Done', lines: turn.checks.map(checkLine) });
		case 'stopped':
			return withFiles({ tone: 'neutral', title: 'Stopped' });
		case 'failed':
		case 'incomplete': {
			const failing = turn.checks.filter((c) => c.status === 'fail').map(checkLine);
			return withFiles({ tone: 'danger', title: 'Not finished', lines: turn.error ? [turn.error, ...failing] : failing });
		}
		case 'needs_input':
			if (turn.reason === 'limited' || turn.reason === 'cost_limit') {
				const spent = turn.reason === 'cost_limit' && turn.usage.cost ? [`${costText(turn.usage.cost.usd)} so far.`] : [];
				return withFiles({ tone: 'info', title: turn.request?.question ?? 'Paused', lines: [...spent, FRESH_BUDGET], ...requestParts(turn.request) });
			}
			return withFiles({ tone: 'info', title: 'Needs you', ...requestParts(turn.request) });
	}
}

/**
 * What a turn's usage shows in its row's meta line.
 *
 * @returns "~$0.42 est., not counting thinking", or the tokens for a model with no price; '' when nothing was counted.
 */
export function usageMeta(usage: TurnUsage): string {
	if (usage.cost) return `${costText(usage.cost.usd)}, not counting thinking`;
	if (usage.tokens) return tokensText(usage.tokens.input + usage.tokens.output);
	return '';
}

/**
 * What a card says about Undo, for the latest turn of a conversation.
 *
 * @param state - 'ready' with the button enabled, 'waiting' with it disabled (the chat is busy, or a call of the turn is still running), or why Undo is unavailable.
 * @returns The button, or the line.
 */
export function undoParts(state: 'ready' | 'waiting' | { unavailable: string }): Pick<ChatCard, 'lines' | 'actions'> {
	if (typeof state === 'object') return { lines: [`Undo is unavailable: ${state.unavailable}.`] };
	return { actions: [{ id: UNDO, label: 'Undo', ...(state === 'waiting' ? { disabled: true } : {}) }] };
}

/** A request's lines and buttons. */
function requestParts(request: NeedsInputRequest | undefined): Pick<ChatCard, 'lines' | 'actions'> {
	if (!request) return {};
	const disabled = request.answeredBy !== undefined;
	switch (request.kind) {
		case 'question':
			return { actions: (request.choices ?? []).map((choice, i) => ({ id: choiceAction(i), label: choice, ...(disabled ? { disabled } : {}) })) };
		case 'variable': {
			const known = request.variableSet === undefined ? '' : request.variableSet ? ' is set in Variables' : ' is not set in Variables';
			return { lines: [`${request.variable ?? 'A Variable'}${known}`], actions: [{ id: OPEN_VARIABLES, label: 'Open Variables' }] };
		}
		case 'continue':
			return { actions: [{ id: CONTINUE, label: 'Continue', ...(disabled ? { disabled } : {}) }] };
	}
}
