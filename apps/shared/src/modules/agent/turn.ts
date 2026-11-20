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
// TURN — how one agent turn ended, the card the chat shows for it, and what it reports
// =============================================================================

/**
 * Every turn ends with one TurnResult. The session file keeps it linked to the turn's bot row, and the chat
 * shows it as the card under that row (`turnCard`), so a reload shows the same card. Its text has passed
 * through `redactDeep`.
 *
 * A turn also reports to its host: one `agent_turn:end`, one `agent_model:request` per request sent and one
 * `agent_tool:call` per tool call planned. AgentEvents is the only list of them. An event carries counts,
 * durations, flags, closed kinds and OwnNames, never free text, and the compile check under it fails the build
 * the moment a prop could hold a prompt, a reply, a path, an argument, an error message or a URL. The shell's
 * sanitizer checks none of that.
 */

import type { StopReason } from 'rocketride';
import type { ChatCard } from 'shell/src/components/chat/types';

import type { ApprovalMode } from './host';
import type { KeyTrouble } from './model';
import { redactText } from './toolkits/common';
import { costText, PRICES, tokensText, uncountedText, type Tokens } from './usage';
import type { Adapter } from './wave/session';

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

/**
 * What the turn used. The step limit counts waves, and the cost limit the cost; the rest is for diagnostics.
 * Every number here comes from the provider's counts; none from characters.
 */
export interface TurnUsage {
	/** Waves run, counting the one the turn ended in. */
	waves: number;
	/** Model requests that count toward the cost: every one sent, retries and the best-effort answer included, but those that cannot have been billed. */
	modelRequests: number;
	/** Tool calls the model planned. */
	toolCalls: number;
	/**
	 * The provider's counts, summed over the requests that had them; unset when none had. Disjoint: `input` is
	 * fresh input, the cache split stays apart. `estimated` is set only on turns saved before real counts, which
	 * have no cache counts (their `input` included them); nothing writes it now.
	 */
	tokens?: Tokens & { readonly estimated?: boolean };
	/** Their cost at the model's price; unset for a model with no price or when no request had counts. `estimated`: as above. */
	cost?: { usd: number; readonly estimated?: boolean };
	/** Requests that came back with no counts; the cost limit held each at its whole reservation. Unset when none. */
	uncounted?: number;
	/** The adapter the turn's session ended on; unset for a turn that ended before it had one. */
	adapter?: Adapter;
}

/**
 * What a needs_input turn asks of the user. `question` and `variable` come
 * from ask_user, and `variable` also from a key the model needs; `continue` is
 * the kind a turn paused by a limit uses.
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
	/** The model the turn asked, as its catalog names it; unset for a turn saved before the choice, or one refused before it started. */
	model?: string;
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
// EVENTS — the one list of what the agent reports
// =============================================================================

/**
 * A name or id an event may carry: one of our own ids, or a name on one of our own lists. Only
 * `ownName` makes one, so free text cannot reach an event without a visible cast.
 */
export type OwnName = string & { readonly __ownName: unique symbol };

/**
 * The one way a name or id enters an event.
 *
 * @returns `value` when `known` holds for it, else 'other'.
 */
export function ownName(value: string, known: (value: string) => boolean): OwnName {
	return (known(value) ? value : 'other') as OwnName;
}

/** The keys every event carries. turnReport adds them, so no call site passes them. */
type TurnKeys = {
	/** This turn; joins its requests and calls to its end. */
	turn_id: OwnName;
	/** The conversation (session id). */
	conversation_id: OwnName;
	/** The model the turn asks, as the price table names it; 'other' for a model the table does not list. */
	model: OwnName;
};

/** Real token counts, apart. On an event only when the provider gave them. */
type TokenProps = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

/**
 * Every event the agent reports, with its props. `type`s, not interfaces, so the shell's reporter
 * (props: Record<string, unknown>) assigns to AgentReport with no cast.
 */
export type AgentEvents = {
	/**
	 * One per turn, however it ended: refused, failed, stopped, unmounted, paused or done. Fired by
	 * AgentSession.execute, the one terminal path.
	 */
	'agent_turn:end': TurnKeys &
		Partial<TokenProps> & {
			outcome: TurnOutcome;
			reason: TurnReason;
			/** Wall time from execute's start to its end, in ms: what the user waited, approval cards included. */
			ms: number;
			/** The approval mode when the turn ended. */
			mode: ApprovalMode;
			adapter: Adapter | 'none';
			waves: number;
			model_requests: number;
			tool_calls: number;
			files_changed: number;
			checks_failed: number;
			/** What a needs_input turn asks of the user; 'none' otherwise. */
			asks: NeedsInputRequest['kind'] | 'none';
			/** USD from real counts at the model's price; absent for a model with no price or a turn with no counted request. */
			usd?: number;
			/** Requests with no counts. */
			uncounted: number;
		};
	/**
	 * One per model request sent, which is one meter reservation: a fresh retry, a resend of an
	 * unusable reply, a continuation and the final answer each send their own. A request the cost
	 * limit refused was never sent and has none (the turn end says cost_limit).
	 */
	'agent_model:request': TurnKeys &
		Partial<TokenProps> & {
			adapter: Adapter;
			/** Why it was sent: the loop's ask, the one resend of an unusable reply, a continuation after the output limit, or the final answer. */
			purpose: 'next' | 'resend' | 'continue' | 'conclude';
			/** The retry on a fresh task after a retryable failure. */
			fresh: boolean;
			outcome: 'answered' | 'unsupported' | 'failed' | 'timeout' | 'stopped';
			/** Why the provider stopped writing, on an answered native turn (a refusal and max_tokens show here); 'none' otherwise. */
			stop: StopReason | 'none';
			/** For failed and timeout: whether one fresh try may fix it. */
			retryable?: boolean;
			/** Whether it counts toward the turn's cost: false only for a request that cannot have been billed. */
			billed: boolean;
			key: KeyTrouble['state'] | 'none';
			/** One attempt, from just after its reservation to its answer or failure. */
			ms: number;
			/** Whether the provider's counts came back. */
			counted: boolean;
			/** Its cost from real counts; absent when uncounted or for a model with no price. */
			usd?: number;
		};
	/** One per tool call the model planned, memory.peek and skipped calls included, so the count equals TurnUsage.toolCalls. */
	'agent_tool:call': TurnKeys & {
		/** The tool, when the run offers one by that name; 'other' for a name the model made up. */
		tool: OwnName;
		/** not_run: refused at approval, held back, or stopped before it started. skipped: a missing argument or a reference that names nothing. */
		outcome: 'ok' | 'error' | 'timeout' | 'not_run' | 'skipped';
		/** Prepare and run, never the approval wait or an open tool question; 0 for skipped and peek. */
		ms: number;
		/** The wave that planned it, counting from 0. */
		wave: number;
	};
};

export type AgentEvent = keyof AgentEvents;

/** Every prop typed so it could hold free text, as `event.prop`; never while each prop is a number, a flag, a closed kind or an OwnName. */
type FreeTextProps = {
	[E in AgentEvent]: { [P in keyof AgentEvents[E]]-?: string extends NonNullable<AgentEvents[E][P]> ? `${E}.${P & string}` : never }[keyof AgentEvents[E]];
}[AgentEvent];

/** Fails to compile, naming the prop, once any event could carry user content. */
const contentFree: [FreeTextProps] extends [never] ? true : FreeTextProps = true;
void contentFree;

/** How the agent reports to its host. The shell's useReport() is one. */
export type AgentReport = <E extends AgentEvent>(event: E, props: AgentEvents[E]) => void;

/** The host's report bound to one turn: a caller passes an event's own props, and the turn's keys are added. */
export type TurnReport = <E extends AgentEvent>(event: E, props: Omit<AgentEvents[E], keyof TurnKeys>) => void;

/** What a string prop may look like: a closed kind, a model id, a tool name or one of our UUIDs. */
const PLAIN_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Our own ids are crypto.randomUUID()s. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Binds the host's report to one turn. Ids pass only in UUID shape, and the model only when the
 * price table lists it. Each event also prints as one console line, `[agent] <event> <props>`, for
 * local stacks (no PostHog key) and the browser eval's trace analyzer. Nothing it does can throw
 * into the turn.
 *
 * The build check above stops a free-text prop being declared; this stops one arriving through a
 * cast or `any`. A value that is not a number, a flag or a plain name drops the whole event, with a
 * warning that names only the prop key. It can't catch a plain name that is itself private (a bare
 * file name passes the pattern), which is why ownName's lists stay the main guard.
 *
 * @param report - The host's report; unset (tests, a host without telemetry) gives a report that does nothing.
 */
export function turnReport(report: AgentReport | undefined, turn: { turnId: string; conversationId: string; model: string }): TurnReport {
	if (!report) return () => undefined;
	const keys: TurnKeys = {
		turn_id: ownName(turn.turnId, (id) => UUID.test(id)),
		conversation_id: ownName(turn.conversationId, (id) => UUID.test(id)),
		model: ownName(turn.model, (model) => PRICES.some((row) => row.model === model)),
	};
	return (event, props) => {
		try {
			// the one cast: Omit<T, keyof TurnKeys> plus TurnKeys is T, which TypeScript can't see through the generic
			const full = { ...props, ...keys } as AgentEvents[typeof event];
			const bad = Object.entries(full).find(([, value]) => !(typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && PLAIN_NAME.test(value))));
			if (bad) {
				console.warn(`[agent] dropped ${event}: ${bad[0]} is not a plain name`);
				return;
			}
			console.info(`[agent] ${event} ${JSON.stringify(full)}`);
			report(event, full);
		} catch {
			// telemetry never breaks a turn
		}
	};
}

/** Real counts as event props. */
export function tokenProps(t: Tokens): TokenProps {
	return { input_tokens: t.input, output_tokens: t.output, cache_read_tokens: t.cacheRead, cache_write_tokens: t.cacheWrite };
}

/**
 * The turn's end as its event: counts and kinds read off the TurnResult, so the card and the event
 * can never disagree on cost. It reads nothing that holds text (the answer, the error, paths, checks' summaries, the request).
 */
export function turnEvent(turn: TurnResult, at: { ms: number; mode: ApprovalMode }): Omit<AgentEvents['agent_turn:end'], keyof TurnKeys> {
	const { usage } = turn;
	return {
		outcome: turn.outcome,
		reason: turn.reason,
		ms: Math.round(at.ms),
		mode: at.mode,
		adapter: usage.adapter ?? 'none',
		waves: usage.waves,
		model_requests: usage.modelRequests,
		tool_calls: usage.toolCalls,
		files_changed: turn.files.length,
		checks_failed: turn.checks.filter((c) => c.status === 'fail').length,
		asks: turn.request?.kind ?? 'none',
		...(usage.tokens ? tokenProps(usage.tokens) : {}),
		...(usage.cost ? { usd: usage.cost.usd } : {}),
		uncounted: usage.uncounted ?? 0,
	};
}

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
 * - needs_input: "Needs you", with a button per choice, Open Variables and
 *   Continue for a variable, or Continue. An answered request's buttons are disabled. A turn
 *   a limit paused says so in its title ("Paused after 60 steps").
 * - stopped: "Stopped", the files changed so far.
 *
 * Files the turn left in place are links; deleted ones are lines. A turn
 * whose model has no known price says the limit counts it at an assumed rate.
 */
export function turnCard(turn: TurnResult): ChatCard {
	const files = turn.files.filter((f) => f.change !== 'deleted').map((f) => f.path);
	const deleted = turn.files.filter((f) => f.change === 'deleted').map((f) => `Deleted ${f.path}`);
	const checkLine = (c: TurnCheck): string => `${c.target}: ${c.summary || c.status.replace('_', ' ')}`;
	const unpriced = turn.usage.tokens && !turn.usage.cost ? ['No known price for this model. The cost limit counts it at an assumed rate.'] : [];
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
				const { cost, uncounted } = turn.usage;
				const spent = turn.reason === 'cost_limit' && cost ? [`${costText(cost.usd, cost.estimated)} so far${uncounted ? `, ${uncountedText(uncounted)}` : ''}.`] : [];
				return withFiles({ tone: 'info', title: turn.request?.question ?? 'Paused', lines: [...spent, FRESH_BUDGET], ...requestParts(turn.request) });
			}
			return withFiles({ tone: 'info', title: 'Needs you', ...requestParts(turn.request) });
	}
}

/**
 * What a turn shows in its row's meta line: the model that answered first, so a change shows row by row, then what it used.
 *
 * @returns "claude-sonnet-5-5 · $0.42" from the provider's counts, which include thinking; "· $0.42 + 1 request not counted"
 *   when some came back without counts; "· 2 requests not counted" when none had counts; the tokens for a model with no
 *   price; a turn saved before real counts as it was, "· ~$0.42 est., not counting thinking"; '' when nothing was counted.
 */
export function usageMeta({ model, usage }: TurnResult): string {
	const { cost, tokens, uncounted } = usage;
	// a turn saved before the cache split has no cache counts
	const counted = tokens ? tokens.input + tokens.output + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) : 0;
	const shown = cost ? `${costText(cost.usd, cost.estimated)}${cost.estimated ? ', not counting thinking' : ''}` : tokens ? tokensText(counted, !!tokens.estimated) : '';
	const used = uncounted ? [shown, uncountedText(uncounted)].filter(Boolean).join(' + ') : shown;
	return used && model ? `${model} · ${used}` : used;
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

/**
 * The request for a key the model needs. The turn's answer row shows its question.
 */
export function keyRequest(trouble: KeyTrouble): NeedsInputRequest {
	const { provider, variable, state } = trouble;
	const question = state === 'missing' ? `Your ${provider} key is not set. Add ${variable} in Variables, then press Continue.` : `${provider} refused the key in ${variable}. Fix it in Variables, then press Continue.`;
	return { id: crypto.randomUUID().slice(0, 8), kind: 'variable', question, variable, variableSet: state === 'rejected' };
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
			return { lines: [`${request.variable ?? 'A Variable'}${known}`], actions: [{ id: OPEN_VARIABLES, label: 'Open Variables' }, { id: CONTINUE, label: 'Continue', ...(disabled ? { disabled } : {}) }] };
		}
		case 'continue':
			return { actions: [{ id: CONTINUE, label: 'Continue', ...(disabled ? { disabled } : {}) }] };
	}
}
