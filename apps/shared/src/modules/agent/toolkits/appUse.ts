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
// USE APP — the agent tries its own copy of an app, for the turn
// =============================================================================

/**
 * `use_app` runs a short list of actions (click, type, select, press, wait_for) on the agent's own copy
 * of an app, and returns a line per action, the errors the page raised, and the page outline after the
 * last action, with refs. The copy is a hidden preview the host opens on the first call for an app in a
 * turn and closes when the turn ends.
 *
 * This module never touches the DOM. The host's AppPage does every page job and answers in domain terms
 * (outcomes, outline lines, problems). What lives here is what the agent decides:
 * - the arguments the model may pass, checked here (the loop validates no schema), with the app by
 *   folder only, so the loop's same-wave ordering always applies
 * - the act the approval list rates: `[appId, ...action kinds]` (approval.ts TOOL_LIST.use_app)
 * - the turn's pages: one per app, opened on first use, living until `ended` aborts, and opened afresh
 *   once a page has left the app
 * - the call's own deadline, so a slow call ends as a result instead of clicking on as a late call
 * - the text the model reads, and its trim to the summary budget (the loop does not cap show())
 * - check_app's preview when the user has none open: the turn's page of the app (leaseForCheck)
 */

import { PageGoneError, type ActionOutcome, type AgentHost, type AppPage, type ElementRef, type OutlineLine, type PageAction, type PageActionKind, type PageProblem, type PageUse, type PreviewApp, type PreviewLease } from '../host';
import { AgentTool, AgentToolkit, type ToolAct, type ToolStep } from '../tools';
import { SUMMARY_BUDGET, SUMMARY_HARD_CAP } from '../wave/summary';
import { brief, isJsonObject, numberArg, textArg } from './common';
import { findApp, readApps } from './inventory';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tool's name. The approval list's TOOL_LIST and the loop's writePaths key on the same string. */
export const USE_APP_TOOL = 'use_app';

/**
 * The longest one call runs, in milliseconds, counting the wait for its page (a boot, a check holding it).
 * Well under the loop's 300 s, so the call stops itself and returns what it saw rather than being cut loose
 * to run on late, holding the page.
 */
const CALL_LIMIT_MS = 120_000;

/** The most actions one call takes; a longer flow goes over several calls, reading the page between them. */
const MAX_ACTIONS = 20;

/** wait_for's wait in seconds: by default, and the bounds a given one is held to. */
const WAIT_FOR_DEFAULT_S = 10;
const WAIT_FOR_MIN_S = 1;
const WAIT_FOR_MAX_S = 30;

/** What an action the page never reached gets. */
const NOT_RUN: ActionOutcome = { status: 'not_run' };

/** The most error lines a result lists; the rest are counted. */
const PROBLEMS_MAX = 10;

/** The share of the outline's room kept from its start when even its element lines don't fit; the rest comes from its end, where a dialog keeps its buttons. */
const HEAD_SHARE = 0.8;

/** Everything use_app says to the model, apart from what the page writes (rocket-ui `pageText.ts`). */
const WORDS = {
	instructions: `## Using apps

- After you change something a person does in an app, for example a form or a button, you can try it with use_app to check that it works. check_app still decides whether the app builds.
- use_app works on your own copy of the app for this turn, and the user can watch. Call it with no actions to read the page, then act on the refs it lists (e1, e2, ...). After a rebuild or a check_app, read the page again.
- Actions run in order and stop at the first failure. For something that shows up later, for example a pipeline's answer, you can use wait_for.
- Buttons in the app run the user's real pipelines and can change their data.`,
	description: 'Use your own copy of an app the way a person would: click, type, pick an option, press a key or wait for text, then read the page. Returns a line per action, any errors the page raised, and the page outline with refs to act on next. With no actions it only reads the page.',
	params: {
		app: "The app's folder under apps/ (for example daybook-ui).",
		actions: `Up to ${MAX_ACTIONS} actions, run in order; the list stops at the first failure. Leave it out to read the page.`,
		ref: 'The element, as the page outline names it (e5). Required for click, type and select; optional for press.',
		text: 'type: the new value of the field. wait_for: the text to wait for.',
		value: 'select: the option, by value or label.',
		key: 'press: Enter, Escape, Tab, ArrowDown, or one character.',
		timeoutS: `wait_for: how long to wait in seconds, ${WAIT_FOR_DEFAULT_S} by default, at most ${WAIT_FOR_MAX_S}.`,
	},
	/** A host with no app preview (the eval runner). Thrown in prepare, so no card asks first. */
	notHere: "use_app isn't available here because there's no app preview. check_app still checks the build.",
	appMissing: "app is required: pass the app's folder under apps/; list_workspace shows them.",
	appByFolder: (folder: string, given: 'id' | 'name'): string => `Pass the app's folder, ${folder}, not its ${given}.`,
	appNoId: (folder: string, path: string): string => `${folder} has no manifest id, so it can't be opened. Fix appManifest.id in ${path}/package.json, then call check_app.`,
	turnEnded: 'the turn ended',
	actionsNotList: 'actions must be a list, for example [{"action":"click","ref":"e5"}]; leave it out to read the page.',
	actionsTooMany: `At most ${MAX_ACTIONS} actions in one call; do the rest in the next call.`,
	/** Names the action a refusal is about. */
	actionAt: (index: number, why: string): string => `actions[${index}]: ${why}`,
	actionNotObject: 'each action must be an object, for example {"action":"click","ref":"e5"}.',
	actionUnknown: 'action must be click, type, select, press or wait_for.',
	actionRef: 'ref must be a ref from the page outline, like e5. Call use_app with no actions to read the page.',
	actionTypeText: 'type needs text, the new value of the field ("" clears it).',
	actionWaitText: 'wait_for needs text, the text to wait for.',
	actionValue: 'select needs value, the option by its value or label.',
	actionKey: 'press needs key, for example Enter, Escape, Tab, ArrowDown or one character.',
	result: {
		done: (changed: boolean, notes: readonly string[]): string => [changed ? 'done, page changed' : 'done, no change', ...notes].join('; '),
		failed: (why: string): string => `failed, ${why}`,
		notRun: 'not run',
		errors: 'Errors during this call:',
		page: 'Page now:',
		empty: '(the page is empty)',
		more: (count: number): string => `- ... and ${count} more`,
		cut: (lines: number, offset: number): string => `... ${lines} lines cut; memory.peek this result from offset ${offset} for the rest`,
	},
} as const;

const PARAMETERS = {
	type: 'object',
	properties: {
		app: { type: 'string', description: WORDS.params.app },
		actions: {
			type: 'array',
			description: WORDS.params.actions,
			items: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['click', 'type', 'select', 'press', 'wait_for'] },
					ref: { type: 'string', description: WORDS.params.ref },
					text: { type: 'string', description: WORDS.params.text },
					value: { type: 'string', description: WORDS.params.value },
					key: { type: 'string', description: WORDS.params.key },
					timeout_s: { type: 'number', description: WORDS.params.timeoutS },
				},
				required: ['action'],
				additionalProperties: false,
			},
		},
	},
	required: ['app'],
	additionalProperties: false,
};

// =============================================================================
// TOOLKIT
// =============================================================================

/** What one run's use_app needs. */
export interface AppUseOptions {
	/** Aborts when the turn ends, however it ends (finish, Stop, a team switch through the chat's unmount): every page this turn opened closes with it. */
	readonly ended: AbortSignal;
	/** The chat the turn belongs to. */
	readonly conversationId: string;
	/** Hides the values the run's file tools hid; names, values and errors go through it before they are cut. */
	readonly hide: (text: string) => string;
	/** The call's own limit in milliseconds (120 s); tests pass a short one. */
	readonly callLimitMs?: number;
}

/**
 * use_app for one run. Built in run.ts on `runEnded`, so its pages live exactly as long as the turn. Its
 * pages are this run's alone: the host lists no agent preview as a dev session. A call that clicks, types,
 * selects or presses asks first; a read or a wait is free (approval.ts TOOL_LIST.use_app).
 */
export class AppUseToolkit extends AgentToolkit {
	readonly name = 'app-use';
	readonly instructions = WORDS.instructions;

	private readonly host: AgentHost;
	private readonly opts: AppUseOptions;
	/** This turn's pages by manifest id: one open, or opening, per app. A failed open is dropped, so the next call tries again. */
	private readonly pages = new Map<string, Promise<AppPage>>();

	/**
	 * Builds the toolkit for one run.
	 *
	 * @param host - The agent host: its workspace lists the apps, and it opens the pages.
	 * @param opts - The turn's end, the chat, the run's hide, and the call limit.
	 */
	constructor(host: AgentHost, opts: AppUseOptions) {
		super();
		this.host = host;
		this.opts = opts;
	}

	/**
	 * check_app's lease (AppCheckOptions.lease), in this order: the user's attached preview; else this
	 * turn's page of the app, once its boot and any use under way are done; else the host's own preview
	 * for the check alone. Borrowing the page boots the app once for the turn, and checks the copy the
	 * agent goes on using.
	 */
	readonly leaseForCheck = async (app: PreviewApp, signal?: AbortSignal): Promise<PreviewLease> => {
		// step: devSession lists only the user's own previews, never an agent's page
		if (this.host.devSession(app.id)?.previewAttached) return this.host.leasePreview(app, signal);
		const opening = this.pages.get(app.id);
		const page = opening ? await opening.catch(() => null) : null;
		if (page) {
			const lease = await page.lend(signal);
			// step: a page that left the app has nothing to check, so the host boots one, unless the turn is over
			if (lease.ok || this.opts.ended.aborted) return lease;
		}
		return this.host.leasePreview(app, signal);
	};

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: USE_APP_TOOL,
				description: WORDS.description,
				parameters: PARAMETERS,
				prepare: (args) => this.prepare(args),
				show: (result) => showUse(result),
			}),
		];
	}

	/**
	 * Gets one call ready: its app, its actions and the act the approval list rates. Reads only.
	 *
	 * @throws On a host with no app preview, before any card; for an app that is not a listed folder with a
	 *   manifest id; or for a bad action.
	 */
	private async prepare(args: Record<string, unknown>): Promise<ToolStep> {
		const open = this.host.openAppPage?.bind(this.host);
		if (!open) throw new Error(WORDS.notHere);
		const app = await this.appOf(args);
		const actions = parseActions(args.actions);
		return { act: actOf(app.id, actions), run: () => this.run(app, actions, open) };
	}

	/**
	 * The app a call names. Only its folder is taken: the loop orders the call against same-wave edits by
	 * `apps/<app>` (writePaths), which an id or a display name would silently miss.
	 *
	 * @throws When `app` is missing, names no app, names one by id or name, or the app has no manifest id.
	 */
	private async appOf(args: Record<string, unknown>): Promise<PreviewApp> {
		// step: untrimmed, because writePaths keys on the argument as given
		const ref = typeof args.app === 'string' ? args.app : '';
		if (!ref) throw new Error(WORDS.appMissing);
		const entry = findApp(await readApps(this.host.vfs, () => false), ref);
		if (entry.folder !== ref) throw new Error(WORDS.appByFolder(entry.folder, entry.id === ref ? 'id' : 'name'));
		if (!entry.id) throw new Error(WORDS.appNoId(entry.folder, entry.path));
		return { id: entry.id, folder: entry.folder, name: entry.name ?? entry.folder };
	}

	/**
	 * Does the call: gets the turn's page of the app, uses it under the call's own deadline, and writes the
	 * result. A failed action is part of the result; only a page that could not open throws.
	 */
	private async run(app: PreviewApp, actions: readonly PageAction[], open: NonNullable<AgentHost['openAppPage']>): Promise<string> {
		// step: the deadline counts the boot too, but never races it: the boot has its own 30 s limit
		const call = deadline(this.opts.ended, this.opts.callLimitMs ?? CALL_LIMIT_MS);
		try {
			return renderUse(actions, await this.usePage(app, actions, open, call.signal), this.opts.hide);
		} finally {
			call.dispose();
		}
	}

	/**
	 * Uses the turn's page of the app. A page that left the app has closed itself, and says so before it
	 * runs anything, so the call drops it and opens a fresh copy, once, within the same deadline.
	 */
	private async usePage(app: PreviewApp, actions: readonly PageAction[], open: NonNullable<AgentHost['openAppPage']>, signal: AbortSignal): Promise<PageUse> {
		const opening = this.pageOf(app, open);
		try {
			return await (await opening).use(actions, signal);
		} catch (err) {
			if (!(err instanceof PageGoneError)) throw err;
			this.forget(app.id, opening);
			return (await this.pageOf(app, open)).use(actions, signal);
		}
	}

	/**
	 * The turn's page of an app: the open one, or a new one tied to `ended`. Calls racing for the first page
	 * share one boot.
	 *
	 * @throws When the turn has ended, or the host could not open the page.
	 */
	private pageOf(app: PreviewApp, open: NonNullable<AgentHost['openAppPage']>): Promise<AppPage> {
		if (this.opts.ended.aborted) return Promise.reject(new Error(WORDS.turnEnded));
		const known = this.pages.get(app.id);
		if (known) return known;
		const opening = open(app, { lifetime: this.opts.ended, conversationId: this.opts.conversationId });
		this.pages.set(app.id, opening);
		opening.catch(() => this.forget(app.id, opening));
		return opening;
	}

	/** Drops a page of the turn, unless a newer one has already taken its place (a racing call reopened first). */
	private forget(appId: string, opening: Promise<AppPage>): void {
		if (this.pages.get(appId) === opening) this.pages.delete(appId);
	}
}

// =============================================================================
// ARGUMENTS AND THE ACT
// =============================================================================

/**
 * The model's actions, checked and parsed. None given means none: the call reads the page.
 *
 * @throws With the action's index and the fix, for a list that is not a list, is too long, or holds a bad action.
 */
function parseActions(raw: unknown): PageAction[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error(WORDS.actionsNotList);
	if (raw.length > MAX_ACTIONS) throw new Error(WORDS.actionsTooMany);
	return raw.map((item, index) => {
		try {
			return parseAction(item);
		} catch (err) {
			throw new Error(WORDS.actionAt(index, (err as Error).message));
		}
	});
}

/**
 * One action, as the page takes it. wait_for's wait is held between WAIT_FOR_MIN_S and WAIT_FOR_MAX_S.
 *
 * @throws Saying what is missing or wrong, and how to put it right.
 */
function parseAction(item: unknown): PageAction {
	if (!isJsonObject(item)) throw new Error(WORDS.actionNotObject);
	switch (textArg(item, 'action')) {
		case 'click':
			return { kind: 'click', ref: refArg(item) };
		case 'type':
			// untrimmed: the spaces are part of what is typed, and "" clears the field
			if (typeof item.text !== 'string') throw new Error(WORDS.actionTypeText);
			return { kind: 'type', ref: refArg(item), text: item.text };
		case 'select': {
			const value = textArg(item, 'value');
			if (!value) throw new Error(WORDS.actionValue);
			return { kind: 'select', ref: refArg(item), value };
		}
		case 'press':
			// untrimmed: " " is the space key
			if (typeof item.key !== 'string' || !item.key) throw new Error(WORDS.actionKey);
			return textArg(item, 'ref') ? { kind: 'press', key: item.key, ref: refArg(item) } : { kind: 'press', key: item.key };
		case 'wait_for': {
			const text = textArg(item, 'text');
			if (!text) throw new Error(WORDS.actionWaitText);
			const seconds = Math.min(Math.max(numberArg(item, 'timeout_s') ?? WAIT_FOR_DEFAULT_S, WAIT_FOR_MIN_S), WAIT_FOR_MAX_S);
			return { kind: 'wait_for', text, timeoutMs: seconds * 1000 };
		}
		default:
			throw new Error(WORDS.actionUnknown);
	}
}

/** The action's ref, or a throw that says what a ref looks like. */
function refArg(item: Record<string, unknown>): ElementRef {
	const ref = textArg(item, 'ref');
	if (!isRef(ref)) throw new Error(WORDS.actionRef);
	return ref;
}

function isRef(text: string): text is ElementRef {
	return /^e[1-9]\d*$/.test(text);
}

/**
 * The act the approval list rates: the app's manifest id, then each action kind once, in first use. Kept
 * small, because approval.ts keys passes by the params' JSON. TOOL_LIST.use_app makes it free when the
 * kinds are only wait_for, or none (a read).
 */
function actOf(appId: string, actions: readonly PageAction[]): ToolAct {
	const kinds: PageActionKind[] = [...new Set(actions.map((action) => action.kind))];
	return { name: USE_APP_TOOL, params: [appId, ...kinds] };
}

/**
 * A signal that aborts when the turn ends or the call's time runs out, and its cleanup. The loop gives
 * run() no signal, so the call makes its own.
 */
function deadline(ended: AbortSignal, ms: number): { signal: AbortSignal; dispose(): void } {
	const call = new AbortController();
	const stop = (): void => call.abort();
	const timer = setTimeout(stop, ms);
	ended.addEventListener('abort', stop, { once: true });
	if (ended.aborted) stop();
	return {
		signal: call.signal,
		dispose: () => {
			clearTimeout(timer);
			ended.removeEventListener('abort', stop);
		},
	};
}

// =============================================================================
// THE RESULT — what the model reads; renderUse and showUse share one format, owned here
// =============================================================================

/**
 * The whole result, stored in memory as is:
 *
 *     1. type e3 "Customer name": done, page changed
 *     2. click e5 "Save": done, page changed; the page asked "Discard changes?" (answered OK)
 *     3. wait_for "Saved": failed, not on the page after 10 s
 *     4. click e9: not run
 *
 *     Errors during this call:
 *     - console: Pipeline invoice-extract failed: ...
 *
 *     Page now:
 *     - heading "Invoices"
 *     - textbox "Customer name" [ref=e3] = "Acme"
 *     - button "Save" [ref=e5]
 *     - dialog "Delete invoice"
 *       - button "Cancel" [ref=e11]
 *     - text "No invoices yet"
 *
 * Names, values, notes and errors go through `hide` before they are cut, because a cut value no longer matches.
 */
function renderUse(actions: readonly PageAction[], use: PageUse, hide: (text: string) => string): string {
	const blocks: string[][] = [];
	if (actions.length) blocks.push(actions.map((action, i) => actionLine(i + 1, action, use.outcomes[i] ?? NOT_RUN, hide)));
	if (use.problems.length) blocks.push([WORDS.result.errors, ...problemLines(use.problems, hide)]);
	blocks.push([WORDS.result.page, ...(use.outline.length ? use.outline.map((line) => outlineLine(line, hide)) : [WORDS.result.empty])]);
	return blocks.map((block) => block.join('\n')).join('\n\n');
}

/** `2. click e5 "Save": done, page changed; the page asked "Discard changes?" (answered OK)`: the action, the element's name as it was, and how it went. */
function actionLine(n: number, action: PageAction, outcome: ActionOutcome, hide: (text: string) => string): string {
	const label: string[] = [action.kind];
	if (action.kind === 'wait_for') label.push(quoted(action.text, hide));
	else if (action.ref) label.push(action.ref);
	if (outcome.status !== 'not_run' && outcome.target) label.push(quoted(outcome.target, hide));
	if (action.kind === 'press') label.push(JSON.stringify(action.key));
	return `${n}. ${label.join(' ')}: ${statusOf(outcome, hide)}`;
}

/** `done, page changed; a note`, `failed, why` or `not run`. Notes and reasons carry the page's own text, so they are hidden and cut too. */
function statusOf(outcome: ActionOutcome, hide: (text: string) => string): string {
	switch (outcome.status) {
		case 'done':
			return WORDS.result.done(
				outcome.changed,
				outcome.notes.map((note) => brief(hide(note)))
			);
		case 'failed':
			return WORDS.result.failed(brief(hide(outcome.why)));
		case 'not_run':
			return WORDS.result.notRun;
	}
}

/** `- console: ...`, at most PROBLEMS_MAX, then `- ... and N more`. */
function problemLines(problems: readonly PageProblem[], hide: (text: string) => string): string[] {
	const lines = problems.slice(0, PROBLEMS_MAX).map((problem) => `- ${problem.kind}: ${brief(hide(problem.text))}`);
	if (problems.length > PROBLEMS_MAX) lines.push(WORDS.result.more(problems.length - PROBLEMS_MAX));
	return lines;
}

/** `  - textbox "Customer name" [ref=e3] = "Acme" (disabled)`, indented two spaces per depth. */
function outlineLine(line: OutlineLine, hide: (text: string) => string): string {
	const name = line.name ? ` ${quoted(line.name, hide)}` : '';
	const ref = line.ref ? ` [ref=${line.ref}]` : '';
	const value = line.value !== undefined ? ` = ${quoted(line.value, hide)}` : '';
	const states = line.states.length ? ` (${line.states.join(', ')})` : '';
	return `${'  '.repeat(line.depth)}- ${line.role}${name}${ref}${value}${states}`;
}

/** One text hidden, put on one line and cut (`brief`), then quoted. */
function quoted(text: string, hide: (text: string) => string): string {
	return JSON.stringify(brief(hide(text)));
}

/** How showUse treats one line of a stored result. */
type LineKind = 'fixed' | 'error' | 'element' | 'text';

/** What showUse does with one line: show it, cut it with its neighbours behind one marker, or leave it out (a text line). */
type Fate = 'shown' | 'cut' | 'left';

/** An outline line for a run of text, which shows after every element line. */
const TEXT_LINE = /^ *- text /;

/**
 * use_app's view of a stored result (its `show`). The loop shows it verbatim and caps nothing, so the
 * budget is kept here. Size is counted as JSON, because the planner sends results through JSON.stringify
 * and every quote and newline costs two.
 *
 * - Whole when it fits SUMMARY_BUDGET.
 * - Headers and action lines always show. Error lines show up to SUMMARY_HARD_CAP; the rest are cut.
 * - The outline gets the rest of the budget. Text lines are left out first, from the middle outward. If
 *   the element lines alone are too long, HEAD_SHARE of the room is kept from the start and the rest
 *   from the end.
 * - Each cut leaves a marker with the offset of its first line, for memory.peek's chunk mode (the
 *   result is text, so path mode refuses it). Text lines left out share one marker at the end.
 */
function showUse(result: string): string {
	if (size(result) <= SUMMARY_BUDGET) return result;
	const lines = linesOf(result);
	const kinds = kindsOf(lines);
	const fates: Fate[] = lines.map(() => 'shown');
	const cost = (i: number): number => size(lines[i].text) + 2;
	const total = (all: number[]): number => all.reduce((sum, i) => sum + cost(i), 0);
	const of = (kind: LineKind): number[] => kinds.flatMap((k, i) => (k === kind ? [i] : []));
	// room for each marker: one after the errors, one in the outline, one for left-out text
	const markers = 3 * (size(WORDS.result.cut(lines.length, result.length)) + 2);

	// step: errors show in order while under the hard cap; the first that doesn't fit is cut with the rest
	let used = total(of('fixed'));
	for (const i of of('error')) {
		if (fates[i - 1] !== 'cut' && used + cost(i) + markers <= SUMMARY_HARD_CAP) used += cost(i);
		else fates[i] = 'cut';
	}

	// step: text lines are left out first, from the middle of the outline outward
	const room = SUMMARY_BUDGET - used - markers;
	const outline = kinds.flatMap((k, i) => (k === 'element' || k === 'text' ? [i] : []));
	let outlineCost = total(outline);
	const middle = (outline[0] + outline[outline.length - 1]) / 2;
	for (const i of of('text').sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))) {
		if (outlineCost <= room) break;
		fates[i] = 'left';
		outlineCost -= cost(i);
	}

	// step: element lines alone too long: keep the start and the end, and cut everything between
	if (outlineCost > room) {
		const kept = outline.filter((i) => fates[i] === 'shown');
		let first = 0;
		let top = 0;
		while (first < kept.length && top + cost(kept[first]) <= room * HEAD_SHARE) top += cost(kept[first++]);
		let last = kept.length;
		let bottom = 0;
		while (last > first && top + bottom + cost(kept[last - 1]) <= room) bottom += cost(kept[--last]);
		const from = first > 0 ? kept[first - 1] + 1 : outline[0];
		const to = last < kept.length ? kept[last] : lines.length;
		for (let i = from; i < to; i++) fates[i] = 'cut';
	}

	const shown: string[] = [];
	lines.forEach((line, i) => {
		if (fates[i] === 'shown') shown.push(line.text);
		else if (fates[i] === 'cut' && fates[i - 1] !== 'cut') {
			let end = i;
			while (fates[end] === 'cut') end++;
			shown.push(WORDS.result.cut(end - i, line.at));
		}
	});
	const left = lines.filter((_, i) => fates[i] === 'left');
	if (left.length) shown.push(WORDS.result.cut(left.length, left[0].at));
	return shown.join('\n');
}

/** A text's size in the planner's prompt, which carries results as JSON. */
function size(text: string): number {
	return JSON.stringify(text).length - 2;
}

/** Each line of a result, with the offset it starts at: what memory.peek's chunk mode reads from. */
function linesOf(result: string): Array<{ text: string; at: number }> {
	let at = 0;
	return result.split('\n').map((text) => {
		const line = { text, at };
		at += text.length + 1;
		return line;
	});
}

/** Each line's kind, from the block it sits in: headers and action lines are fixed, then error lines, then the outline. */
function kindsOf(lines: ReadonlyArray<{ text: string }>): LineKind[] {
	let block: 'actions' | 'errors' | 'page' = 'actions';
	return lines.map(({ text }): LineKind => {
		if (text === WORDS.result.errors || text === WORDS.result.page) {
			block = text === WORDS.result.errors ? 'errors' : 'page';
			return 'fixed';
		}
		if (block === 'page') return TEXT_LINE.test(text) ? 'text' : 'element';
		return block === 'errors' && text ? 'error' : 'fixed';
	});
}
