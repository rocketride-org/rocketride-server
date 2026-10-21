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
// RUN — one agent run, assembled from the toolkits
// =============================================================================

/**
 * `runAgent` builds everything one run needs and drives the Wave loop: the
 * workspace view with the guides at `.rocketride/`, the toolkits in mount
 * order, the save hook, the prompt start (built once, never changed), the
 * model, and the record of check results, which is also the loop's finish
 * rule. It streams each wave's progress as `thinking` chunks and sends the
 * answer as one `content` chunk, with the checks line the code builds from the
 * record.
 *
 * Everything that only works in the browser (the model pipeline, the confirm
 * dialog, Monaco's markers) has a default here and comes in through `deps`
 * otherwise, so tests run a whole run without a browser or an engine.
 */

import { Question } from 'rocketride';
import type { ChatMessage } from 'shell';

import { GuideFileSystem } from './guides';
import type { AgentHost } from './host';
import { CORE_PROMPT } from './prompts';
import { APP_CHECK_TOOL, AppCheckToolkit, monacoMarkerSource, reportPassed, typesNote } from './toolkits/appCheck';
import type { CheckReport, MarkerSource } from './toolkits/appCheck';
import { AppToolkit, DEPLOY_APP_TIMEOUT_MS } from './toolkits/appTools';
import { NOT_CONNECTED_MESSAGE, shellConfirm, type ClientGetter, type ConfirmFn } from './toolkits/common';
import { FilesystemTools, normalizePath } from './toolkits/filesystem';
import { findApp, InventoryToolkit, readApps } from './toolkits/inventory';
import { PipelineDeployToolkit } from './toolkits/pipelineDeploy';
import { PipelineDesignToolkit, validateNote, validateSaved, type SaveValidation } from './toolkits/pipelineDesign';
import { PipelineRunToolkit } from './toolkits/pipelineRun';
import { composeToolkits } from './tools';
import { runLoop, TOOL_TIMEOUT_MS, type FinishRule, type LoopResult, type RanCall } from './wave/loop';
import { buildPrefix } from './wave/plan';
import type { AppPrompts, HistoryTurn, ModelCall, QuestionSpec } from './wave/plan';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tools whose calls change the work, so what they touched must be checked before the run may finish. */
export const CHANGE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'rename', 'delete_file', 'create_app']);

/** The longest a save or a check waits for Monaco's marker source to load, in milliseconds. */
const MARKERS_LOAD_LIMIT_MS = 10_000;

/** What the answer says when work changed and the run ended before a check passed after it. */
const NOT_CHECKED = 'Not checked: the run stopped before a check passed after the last change.';

/** A path inside an app: the app's folder under `apps/`, then at least one more segment. */
const APP_PATH = /^apps\/([^/]+)\/./;

/** An app's own folder, and nothing below it. */
const APP_FOLDER = /^apps\/([^/]+)$/;

/** An app's TypeScript file: the app folder, then the path inside the app. */
const APP_TYPESCRIPT_FILE = /^apps\/([^/]+)\/(.+\.tsx?)$/;

/** The folder in create_app's result (`Created <id> in apps/<folder>.`). */
const CREATED_APP = / in apps\/([^/\s]+)\.$/;

/** The start of a line the code owns, once markdown is stripped; any the model writes are dropped (spec §7). Emphasis may close before the colon (`**Checked**:`). */
const CHECKS_LINE = /^(?:Checked|Not checked)[*_]*:/;

/** The list and quote markers, emphasis and spaces a line may open with (`- `, `> `, `**`, `_`). */
const LEADING_MARKDOWN = /^[\s>*+_-]+/;

// =============================================================================
// TYPES
// =============================================================================

/** What one run is asked to do, and with what. */
export interface AgentRunOptions {
	/** The conversation before this request, as the chat renders it. */
	history: ChatMessage[];
	/** The mounting app's workspace map and guide router. */
	prompts: AppPrompts;
	/** The token of the running LLM pipeline; read again after a restart. */
	token: () => Promise<string>;
	/** Restarts the LLM pipeline after it fails. */
	onPipelineError?: () => Promise<void>;
}

/** What one run needs from its host. The optional parts have browser defaults; tests always pass them. */
export interface AgentDeps {
	/** The mounting app's workspace, guides, scaffolding and dev sessions. */
	host: AgentHost;
	/** The connected RocketRide client, or null when there is none. */
	client: ClientGetter;
	/** Asks the model one question (default: the LLM pipeline behind `options.token`). */
	model?: ModelCall;
	/** Asks the user to confirm (default: the shell's confirm dialog). */
	confirm?: ConfirmFn;
	/** Gets Monaco's marker source, or null when there is none (default: the editor's, loaded once). */
	markers?: () => Promise<MarkerSource | null>;
}

// =============================================================================
// MARKERS — the editor's marker source, loaded once and never in the way
// =============================================================================

/**
 * Wraps a marker source loader so a save or a check is never held up by it.
 * The load runs once and its source is shared. A load that fails resolves
 * null, and the next call tries again. A load still going after `limitMs`
 * resolves null for that call; later calls get the source once it arrives.
 *
 * @param load - Loads the marker source.
 * @param limitMs - The longest one call waits for the load, in milliseconds.
 * @returns A getter that resolves the source, or null when there is none yet.
 */
function guardedMarkerSource(load: () => Promise<MarkerSource>, limitMs = MARKERS_LOAD_LIMIT_MS): () => Promise<MarkerSource | null> {
	let loading: Promise<MarkerSource | null> | null = null;
	return () => {
		// step: started inside a chain, so even a loader that throws at once resolves null
		loading ??= Promise.resolve()
			.then(load)
			.catch(() => {
				loading = null;
				return null;
			});
		const pending = loading;
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(null), limitMs);
			void pending.then((src) => {
				clearTimeout(timer);
				resolve(src);
			});
		});
	};
}

/** Monaco's marker source for every run in this page; it loads Monaco the first time a save or a check asks. */
const editorMarkers = guardedMarkerSource(monacoMarkerSource);

// =============================================================================
// CHECK RECORD — what the run checked, and the rule for when it may finish
// =============================================================================

/**
 * Every check result the run saw, and the finish rule the loop asks before it
 * accepts an answer. Only tool results write to it: check_app's reports, the
 * validate each pipeline save runs, and the calls each wave ran. The rule is
 * per target:
 *
 * - An app the run changed needs a passing check_app on it in a wave after the
 *   wave of its last change. A check_app on it that fails or errors, or that
 *   timed out and ended later (the model never read it), leaves it unchecked
 *   until a later pass. A step that did not run counts as a pass for now.
 * - A pipeline the run changed must not have failed validate on its latest
 *   save. Every save validates, so it needs no call of its own. Deleting a
 *   pipeline drops it; renaming one carries its latest result to the new path.
 * - A change to anything else (`nodes/`, other files) needs nothing.
 *
 * A change is a call to one of CHANGE_TOOLS, even one that failed, since a
 * write may land before its error: a path inside `apps/<folder>/` changes that
 * app, and create_app changes the app its result names. Deleting an app's whole
 * folder drops the app's record (there is nothing left to check); renaming the
 * folder moves the record to the new folder, as a change.
 */
export class CheckRecord implements FinishRule {
	readonly checkTool = APP_CHECK_TOOL;
	/** Whether any call changed the work, even one that failed. */
	changed = false;

	/** The wave now running. */
	private wave = -1;
	/** Each app the run changed or checked, by folder under `apps/`, in the order first seen. */
	private readonly apps = new Map<string, { changed: number; passed: number; report?: CheckReport }>();
	/** What validate found on each pipeline's latest save, by path, in the order first saved. */
	private readonly pipelines = new Map<string, SaveValidation>();

	/**
	 * @param appFolder - Finds the folder of the app a check_app call names, the
	 *   way check_app does; resolves null when no app matches.
	 */
	constructor(private readonly appFolder: (ref: string) => Promise<string | null>) {}

	/**
	 * A wave starts; results recorded from here on belong to it.
	 *
	 * @param wave - The wave number.
	 */
	beginWave(wave: number): void {
		this.wave = wave;
	}

	/**
	 * Records a check_app report (AppCheckToolkit's callback).
	 *
	 * @param folder - The checked app's folder.
	 * @param report - What the check saw.
	 */
	appChecked(folder: string, report: CheckReport): void {
		const app = this.app(folder);
		app.report = report;
		app.passed = reportPassed(report) ? this.wave : -1;
	}

	/**
	 * Records what validate found on a pipeline save (the save hook).
	 *
	 * @param path - The saved pipeline's canonical path.
	 * @param validation - What validate found.
	 */
	pipelineSaved(path: string, validation: SaveValidation): void {
		this.pipelines.set(path, validation);
	}

	/**
	 * Hears a wave's calls: each change marks what it touched, and a check_app
	 * that errored or ended late voids its app's pass.
	 *
	 * @param calls - The calls, as the loop hands them over.
	 */
	async endWave(calls: RanCall[]): Promise<void> {
		for (const call of calls) {
			if (call.tool === APP_CHECK_TOOL) {
				if (call.error === undefined && !call.late) continue;
				const folder = await this.appFolder(String(call.args.app ?? ''));
				if (folder !== null) this.app(folder).passed = -1;
			} else if (CHANGE_TOOLS.has(call.tool)) {
				this.changed = true;
				this.change(call);
			}
		}
	}

	/**
	 * What is still unchecked, in Wave's style.
	 *
	 * @returns A refusal naming each app with no passing check_app since its last change and each pipeline whose last save failed validate, or null.
	 */
	unchecked(): string | null {
		const apps = [...this.apps].filter(([, app]) => app.changed >= 0 && app.passed <= app.changed).map(([folder]) => folder);
		const pipes = [...this.pipelines].filter(([, v]) => 'errors' in v && v.errors.length > 0).map(([path]) => path);
		const parts: string[] = [];
		if (apps.length > 0) parts.push(`call ${APP_CHECK_TOOL} on ${apps.length > 1 ? 'each of ' : ''}${apps.join(', ')} on its own, after your last change to it, and fix what it reports`);
		if (pipes.length > 0) parts.push(`${pipes.join(', ')} failed validation on ${pipes.length > 1 ? 'their' : 'its'} last save: fix ${pipes.length > 1 ? 'them' : 'it'} and save again`);
		return parts.length > 0 ? `Not finished: ${parts.join('; ')} before done=true.` : null;
	}

	/**
	 * Builds the checks line from the newest result per target. The model never
	 * writes or edits it. One target reads "Checked: a · b"; several are labeled
	 * by target and separated by semicolons. Apps are labeled by their check's
	 * target, pipelines by path.
	 *
	 * @returns The line, or '' when there is nothing to report.
	 */
	checksLine(): string {
		// step: an app says its check's step summaries; a pipeline says what validate found on its latest save
		const groups: Array<{ target: string; text: string }> = [];
		for (const { report } of this.apps.values()) {
			if (!report) continue;
			const text = report.evidence
				.map((e) => e.summary)
				.filter((s) => s.length > 0)
				.join(' · ');
			groups.push({ target: report.target, text });
		}
		for (const [path, v] of this.pipelines) {
			const text = 'failed' in v ? 'validate not run' : v.errors.length === 0 ? 'validate OK' : `validate: ${v.errors.length} ${v.errors.length === 1 ? 'error' : 'errors'}`;
			groups.push({ target: path, text });
		}
		const said = groups.filter((g) => g.text.length > 0);
		if (said.length === 0) return '';
		// step: a lone group needs no label
		if (said.length === 1) return `Checked: ${said[0].text}`;
		return `Checked: ${said.map((g) => `${g.target}: ${g.text}`).join('; ')}`;
	}

	/** The record of an app, made on first use. */
	private app(folder: string): { changed: number; passed: number; report?: CheckReport } {
		let app = this.apps.get(folder);
		if (!app) {
			app = { changed: -1, passed: -1 };
			this.apps.set(folder, app);
		}
		return app;
	}

	/** Marks what one change call touched; deletes and renames that worked also drop or move what they took along. */
	private change(call: RanCall): void {
		const ok = call.error === undefined;
		switch (call.tool) {
			case 'write_file':
			case 'edit_file':
				this.touch(canonical(call.args.path));
				return;
			case 'delete_file': {
				const path = canonical(call.args.path);
				this.touch(path);
				if (ok && path !== null) this.drop(path);
				return;
			}
			case 'rename': {
				const from = canonical(call.args.oldPath);
				const to = canonical(call.args.newPath);
				this.touch(from);
				this.touch(to);
				if (ok && from !== null && to !== null) this.move(from, to);
				return;
			}
			case 'create_app': {
				const folder = CREATED_APP.exec(call.result ?? '')?.[1];
				if (folder) this.app(folder).changed = this.wave;
				return;
			}
		}
	}

	/** Marks the app a path sits inside as changed now; a path outside every app changes none. */
	private touch(path: string | null): void {
		const folder = path === null ? undefined : APP_PATH.exec(path)?.[1];
		if (folder) this.app(folder).changed = this.wave;
	}

	/** Forgets every app folder and pipeline at or under a deleted path. */
	private drop(path: string): void {
		for (const folder of [...this.apps.keys()]) if (within(`apps/${folder}`, path)) this.apps.delete(folder);
		for (const pipe of [...this.pipelines.keys()]) if (within(pipe, path)) this.pipelines.delete(pipe);
	}

	/**
	 * Moves what a rename took along. An app folder lands changed under its new
	 * folder (a rename is a change to it), or is dropped when it no longer sits
	 * directly under `apps/`. A pipeline keeps its latest result at its new
	 * path, or is dropped when that is no longer a `.pipe` file.
	 */
	private move(from: string, to: string): void {
		for (const [folder, app] of [...this.apps]) {
			const path = `apps/${folder}`;
			if (!within(path, from)) continue;
			this.apps.delete(folder);
			const moved = APP_FOLDER.exec(to + path.slice(from.length))?.[1];
			if (moved) this.apps.set(moved, { ...app, changed: this.wave });
		}
		for (const [pipe, validation] of [...this.pipelines]) {
			if (!within(pipe, from)) continue;
			this.pipelines.delete(pipe);
			const moved = to + pipe.slice(from.length);
			if (moved.endsWith('.pipe')) this.pipelines.set(moved, validation);
		}
	}
}

/**
 * A path argument spelled the way the file tools spell it.
 *
 * @param raw - The argument as the call ran with it.
 * @returns The canonical path, or null for one the file tools refuse (that call touched nothing).
 */
function canonical(raw: unknown): string | null {
	try {
		return normalizePath(raw);
	} catch {
		return null;
	}
}

/**
 * Whether a path is another path or sits under it.
 *
 * @param path - The path to test.
 * @param root - The path that may hold it.
 * @returns True for `root` itself and anything under `root/`.
 */
function within(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

// =============================================================================
// HISTORY AND ANSWER
// =============================================================================

/**
 * Turns the chat's messages into the model's history: what the user said and
 * the answers the agent gave. Thinking rows (bot rows with a result key),
 * error banners, and system and status rows are not part of the conversation.
 *
 * @param messages - The chat's messages, oldest first.
 * @returns The history turns, oldest first.
 */
function toHistory(messages: ChatMessage[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const m of messages) {
		if (m.sender === 'user') turns.push({ role: 'user', content: m.text });
		else if (m.sender === 'bot' && !m.isError && !m.resultKey) turns.push({ role: 'assistant', content: m.text });
	}
	return turns;
}

/**
 * Whether a line of the model's answer is one of the lines the code owns.
 *
 * @param line - One line of the answer.
 * @returns True when, past any leading list or quote marker and emphasis, it starts with "Checked:" or "Not checked:" (so `- **Checked:** …` counts).
 */
function isChecksLine(line: string): boolean {
	return CHECKS_LINE.test(line.replace(LEADING_MARKDOWN, ''));
}

/**
 * The text the user reads: the model's answer, then the checks line built from
 * the record, then a warning when the run changed the work and stopped before
 * finishing. Lines in the answer that start with "Checked:" or "Not checked:",
 * markdown-wrapped or not, are dropped, because only the code writes those.
 *
 * @param result - How the loop ended.
 * @param checks - Every check result the run recorded.
 * @returns The answer, its checks line and any warning, separated by blank lines.
 */
function finalText(result: LoopResult, checks: CheckRecord): string {
	const answer = result.answer
		.split('\n')
		.filter((line) => !isChecksLine(line))
		.join('\n')
		.trim();
	const parts = [answer, checks.checksLine()];
	if (checks.changed && result.stopReason !== 'done') parts.push(NOT_CHECKED);
	return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * The median of some timings.
 *
 * @param values - The timings, in milliseconds.
 * @returns The middle value (the mean of the middle two for an even count), rounded; 0 when there are none.
 */
function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

// =============================================================================
// CHAT MODEL — one model call, asked on the LLM pipeline's token
// =============================================================================

/**
 * Each model call is `client.chat({ token, question })` on the token of the
 * LLM pipeline: text in, a JSON plan out. A provider that fails does not make
 * `chat` throw; the pipeline answers with text starting "**LLM error** —".
 * This section turns that answer, a dead token, and an empty reply into errors
 * the loop can show as a banner, and times every round trip.
 */

// =============================================================================
// ERRORS
// =============================================================================

/** The start of the answer the LLM pipeline writes when the provider call failed (packages/ai/src/ai/common/llm_base.py:95). */
const LLM_ERROR_PREFIX = '**LLM error** — ';

/** Why a model call failed: the provider rejected it, the pipeline died, or nothing came back. */
class ModelError extends Error {
	/**
	 * @param message - What went wrong, readable as it stands.
	 * @param kind - 'provider' when the model call inside the pipeline failed, 'pipeline' when
	 *   the pipeline stopped responding, 'empty' when it answered with nothing.
	 */
	constructor(
		message: string,
		readonly kind: 'provider' | 'pipeline' | 'empty'
	) {
		super(message);
		this.name = 'ModelError';
	}
}

// =============================================================================
// THE CALL
// =============================================================================

/** The part of the RocketRide client a model call needs. */
export interface ChatClient {
	/**
	 * Asks the pipeline behind `token` one question.
	 *
	 * @param o - The pipeline token and the question to send.
	 * @returns The pipeline result, with the model's text in `answers`. Its other
	 *   fields depend on the pipeline; the index signature lets the client's
	 *   `PIPELINE_RESULT` fit, which an all-optional type would refuse.
	 */
	chat(o: { token: string; question: unknown }): Promise<{ answers?: unknown[]; [field: string]: unknown }>;
}

/** What createChatModel needs from its host. */
export interface ChatModelOptions {
	/** The connected client, or null when there is none. */
	client: () => ChatClient | null;
	/** The token of the running LLM pipeline. Read again after a restart, since a new pipeline has a new token. */
	token: () => Promise<string>;
	/** Turns a question into whatever `client.chat` takes. */
	toQuestion: (q: QuestionSpec) => unknown;
	/** Restarts the LLM pipeline. Called once per model call, when the pipeline fails the first time. */
	onPipelineError?: () => Promise<void>;
}

/**
 * Builds the model call the Wave loop uses.
 *
 * The call resolves with the model's text, or rejects: a missing client with a
 * plain Error, anything else with a ModelError. A pipeline failure gets one
 * restart (`onPipelineError`) and one retry; a second failure is final.
 *
 * @param o - The client, token and hooks the host supplies.
 * @returns The model call.
 */
function createChatModel(o: ChatModelOptions): ModelCall {
	return async (q) => {
		const client = o.client();
		if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
		const question = o.toQuestion(q);

		const ask = async (): Promise<{ answers?: unknown[] }> => client.chat({ token: await o.token(), question });

		const started = performance.now();
		try {
			let result: { answers?: unknown[] };
			try {
				result = await ask();
			} catch (first) {
				if (!o.onPipelineError) throw pipelineError(first);
				try {
					await o.onPipelineError();
					result = await ask();
				} catch (second) {
					throw pipelineError(second);
				}
			}
			return answerText(result);
		} finally {
			const ms = Math.round(performance.now() - started);
			console.log(`[agent] model call ${ms} ms`);
		}
	};
}

/** Wraps a failed chat call in the error the user reads. */
function pipelineError(cause: unknown): ModelError {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new ModelError(`The model pipeline stopped responding: ${reason}`, 'pipeline');
}

/** Pulls the model's text out of a pipeline result, or throws the error it stands for. */
function answerText(result: { answers?: unknown[] }): string {
	const first = result.answers?.[0];
	const text = typeof first === 'string' ? first : first == null ? '' : JSON.stringify(first);
	if (text.trim() === '') throw new ModelError('The model returned no answer.', 'empty');
	if (text.startsWith(LLM_ERROR_PREFIX)) {
		throw new ModelError(`The model provider failed: ${text.slice(LLM_ERROR_PREFIX.length)}`, 'provider');
	}
	return text;
}

// =============================================================================
// THE QUESTION
// =============================================================================

/**
 * Builds the client's Question from a spec. This is the only runtime import of
 * 'rocketride' in the agent; under shared:test it is undefined, so tests pass
 * a fake `toQuestion` to createChatModel instead of calling this.
 *
 * @param q - The question to send.
 * @returns The client's Question, in the order Wave's prompt expects.
 */
function toRocketRideQuestion(q: QuestionSpec): Question {
	const question = new Question({ expectJson: q.expectJson, cachePrefix: q.cachePrefix, role: q.role });
	for (const { title, text } of q.instructions) question.addInstruction(title, text);
	for (const turn of q.history) question.addHistory({ role: turn.role, content: turn.content });
	for (const goal of q.goals) question.addGoal(goal);
	for (const item of q.context) question.addContext(item);
	question.addQuestion(q.question);
	return question;
}

// =============================================================================
// RUN
// =============================================================================

/**
 * Runs the agent once on a request. Progress goes to the callback as
 * `thinking` chunks, one per wave except the wave whose answer is accepted,
 * and the answer goes as one `content` chunk. One summary line is logged.
 *
 * @param request - What the user asked for.
 * @param callback - Receives each chunk as (type, content).
 * @param options - The conversation so far, the app's prompts and the model pipeline's token.
 * @param deps - The host, the client getter, and the parts tests replace.
 * @throws The model's error when it fails before the run gathered anything.
 */
export async function runAgent(request: string, callback: (type: string, content: string) => void, options: AgentRunOptions, deps: AgentDeps): Promise<void> {
	const { host, client } = deps;
	const model = deps.model ?? createChatModel({ client, token: options.token, toQuestion: toRocketRideQuestion, onPipelineError: options.onPipelineError });
	const confirm = deps.confirm ?? shellConfirm();
	const markers = deps.markers ?? editorMarkers;

	// step: the record of check results, which is also the loop's finish rule; it names an app the way check_app does
	const checks = new CheckRecord(async (ref) => {
		try {
			return findApp(await readApps(host.vfs, () => false), ref.trim()).folder;
		} catch {
			return null;
		}
	});

	// step: the workspace with the guides; every save that works returns the types of an app's
	// TypeScript file or the validate of a pipeline, and the validate is recorded for the finish rule
	const vfs = new GuideFileSystem(host.vfs, host.guides);
	const afterSave = async (path: string): Promise<string> => {
		const appFile = APP_TYPESCRIPT_FILE.exec(path);
		if (appFile) return typesNote(vfs, markers, appFile[1], appFile[2]);
		if (!path.endsWith('.pipe')) return '';
		const validation = await validateSaved(client, vfs, path);
		checks.pipelineSaved(path, validation);
		return validateNote(validation);
	};

	// step: the toolkits in mount order
	const composed = composeToolkits([
		// one file toolkit per run, so reads never carry over; its saves run the hook above
		new FilesystemTools(vfs, undefined, afterSave),
		new InventoryToolkit(vfs, (id) => host.devSession(id) !== null),
		new PipelineDesignToolkit(client, vfs),
		new PipelineRunToolkit(client, vfs),
		new PipelineDeployToolkit(client, vfs, confirm),
		new AppToolkit(client, host, confirm),
		// check_app hands each report to the record
		new AppCheckToolkit(host, markers, (folder, report) => checks.appChecked(folder, report)),
	]);

	const result = await runLoop({
		request,
		history: toHistory(options.history),
		prefix: buildPrefix(CORE_PROMPT, options.prompts, composed),
		tools: composed.tools,
		model,
		finish: checks,
		emit: (type, text) => callback(type, text),
		timeoutMs: (tool) => (tool === 'deploy_app' ? DEPLOY_APP_TIMEOUT_MS : TOOL_TIMEOUT_MS),
	});

	callback('content', finalText(result, checks));
	console.log(`[agent] stop=${result.stopReason} waves=${result.waves} modelCalls=${result.modelMs.length} medianMs=${median(result.modelMs)} guides=[${[...vfs.guidesRead].join(',')}]`);
}
