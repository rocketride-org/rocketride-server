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
// USE APP — the agent reads its own copy of an app, for the turn
// =============================================================================

/**
 * `use_app` reads the agent's own copy of an app and returns the errors the page raised and the page
 * outline, with refs. The copy is a hidden preview the host opens on the first call for an app in a turn
 * and closes when the turn ends.
 *
 * This module never touches the DOM. The host's AppPage does every page job and answers in domain terms
 * (outline lines, problems). What lives here is what the agent decides:
 * - the app a call names, by folder only, so the loop's same-wave ordering always applies
 * - the act the approval list rates (approval.ts TOOL_LIST.use_app)
 * - the turn's pages: one per app, opened on first use, living until `ended` aborts
 * - the call's own deadline, so a slow call ends as a result instead of running on as a late call
 * - the text the model reads, and its trim to the summary budget (the loop does not cap show())
 */

import type { AgentHost, AppPage, OutlineLine, PageProblem, PageUse, PreviewApp } from '../host';
import { AgentTool, AgentToolkit, type ToolAct, type ToolStep } from '../tools';
import { SUMMARY_BUDGET, SUMMARY_HARD_CAP } from '../wave/summary';
import { brief } from './common';
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
	},
	/** A host with no app preview (the eval runner). Thrown in prepare, so no card asks first. */
	notHere: "use_app isn't available here because there's no app preview. check_app still checks the build.",
	appMissing: "app is required: pass the app's folder under apps/; list_workspace shows them.",
	appByFolder: (folder: string, given: 'id' | 'name'): string => `Pass the app's folder, ${folder}, not its ${given}.`,
	appNoId: (folder: string, path: string): string => `${folder} has no manifest id, so it can't be opened. Fix appManifest.id in ${path}/package.json, then call check_app.`,
	turnEnded: 'the turn ended',
	result: {
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
 * pages are this run's alone: the host lists no agent preview as a dev session.
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
	 * Gets one call ready: its app and the act the approval list rates. Reads only.
	 *
	 * @throws On a host with no app preview, before any card, or for an app that is not a listed folder with a manifest id.
	 */
	private async prepare(args: Record<string, unknown>): Promise<ToolStep> {
		const open = this.host.openAppPage?.bind(this.host);
		if (!open) throw new Error(WORDS.notHere);
		const app = await this.appOf(args);
		return { act: actOf(app.id), run: () => this.run(app, open) };
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
	 * Does the call: gets the turn's page of the app, reads it under the call's own deadline, and writes the
	 * result. Only a page that could not open throws.
	 */
	private async run(app: PreviewApp, open: NonNullable<AgentHost['openAppPage']>): Promise<string> {
		// step: the deadline counts the boot too, but never races it: the boot has its own 30 s limit
		const call = deadline(this.opts.ended, this.opts.callLimitMs ?? CALL_LIMIT_MS);
		try {
			const page = await this.pageOf(app, open);
			return renderUse(await page.use([], call.signal), this.opts.hide);
		} finally {
			call.dispose();
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
		opening.catch(() => {
			if (this.pages.get(app.id) === opening) this.pages.delete(app.id);
		});
		return opening;
	}
}

/**
 * The act the approval list rates: the app's manifest id. Kept small, because approval.ts keys passes by
 * the params' JSON. TOOL_LIST.use_app makes a read free.
 */
function actOf(appId: string): ToolAct {
	return { name: USE_APP_TOOL, params: [appId] };
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
 * Names, values and errors go through `hide` before they are cut, because a cut value no longer matches.
 */
function renderUse(use: PageUse, hide: (text: string) => string): string {
	const blocks: string[][] = [];
	if (use.problems.length) blocks.push([WORDS.result.errors, ...problemLines(use.problems, hide)]);
	blocks.push([WORDS.result.page, ...(use.outline.length ? use.outline.map((line) => outlineLine(line, hide)) : [WORDS.result.empty])]);
	return blocks.map((block) => block.join('\n')).join('\n\n');
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
