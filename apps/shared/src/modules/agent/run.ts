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
 * `runAgent` builds what one run needs and drives the Wave loop. It streams each
 * wave's progress as `thinking` chunks and the answer as one `content` chunk with
 * the code-built checks line; a stopped run sends no `content`.
 * The step limit and the cost limit both end the turn as needs_input. The Undo
 * record holds file content, so it goes to `options.undo`, never the result.
 * Browser-only parts (model pipeline, Monaco markers) come in through `deps`, so
 * tests run without a browser. One `Approvals` per run rates every tool act; the
 * model's own `chat` calls keep the real client.
 */

import { Question } from 'rocketride';
import type { ChatMessage } from 'shell';
import type { ChatAskCard, ChatAsking } from 'shell/src/components/chat/types';

import { isReferencePath } from '../vfs/referenceTree';
import { DEFAULT_LIMITS, findAgentHost, type AgentHost } from './host';
import { CORE_PROMPT } from './prompts';
import { APP_CHECK_TOOL, AppCheckToolkit, monacoMarkerSource, reportPassed, typesNote, validateNote, validateSaved } from './toolkits/appCheck';
import type { CheckReport, MarkerSource, SaveValidation } from './toolkits/appCheck';
import { Approvals } from './toolkits/approval';
import { AppToolkit, DEPLOY_APP_TIMEOUT_MS } from './toolkits/appTools';
import { AskUserToolkit } from './toolkits/askUser';
import { NOT_CONNECTED_MESSAGE, redactDeep, redactText, shellChoice, type ChoiceFn, type ClientGetter } from './toolkits/common';
import { FilesystemTools, normalizePath, type FileTracker } from './toolkits/filesystem';
import { findApp, InventoryToolkit, readApps } from './toolkits/inventory';
import { RocketRideClientToolkit, RunLedger } from './toolkits/rocketrideClient';
import { UNDO_ROW, type UndoRecord } from './toolkits/undo';
import { composeToolkits, UserTime } from './tools';
import { outcomeOf, TurnError, type NeedsInputRequest, type RunRecord, type TurnCheck, type TurnResult, type TurnUsage } from './turn';
import { CostLimitError, dollars, UsageMeter } from './usage';
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

const NOT_CHECKED = 'Not checked: the run stopped before a check passed after the last change.';

/** A path inside an app: the app's folder under `apps/`, then at least one more segment. */
const APP_PATH = /^apps\/([^/]+)\/./;

/** An app's own folder, and nothing below it. */
const APP_FOLDER = /^apps\/([^/]+)$/;

/** An app's TypeScript file: the app folder, then the path inside the app. */
const APP_TYPESCRIPT_FILE = /^apps\/([^/]+)\/(.+\.tsx?)$/;

/** The folder in create_app's result (`Created <id> in apps/<folder>.`). */
const CREATED_APP = / in apps\/([^/\s]+)\.$/;

/** The start of a line the code owns, once markdown is stripped; any the model writes are dropped. Emphasis may close before the colon (`**Checked**:`). */
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
	/** Aborted when the user stops the run; the loop then starts nothing new and ends. */
	signal: AbortSignal;
	/** Takes the messages the user sent since the last take, oldest first. */
	takeQueued: () => string[];
	/** Shows a "Needs your OK" card in the chat and waits for the answer (the turn's ask). Absent: an act that asks is refused in Ask mode. */
	ask?: (card: ChatAskCard) => ChatAsking;
	/** The turn's id (default: a new one). */
	turnId?: string;
	/** The conversation the turn belongs to (its session id), for the runs it starts. */
	conversationId?: string;
	/** The runs the conversation started. The run adds the ones it starts to this array (default: none, kept nowhere). */
	runs?: RunRecord[];
	/** The model the pipeline behind `token` runs, as the price table names it; unset when unknown, so nothing is priced. */
	model?: string;
	/** Takes the run's Undo record when the run ends, however it ends. It holds file content, so it stays in memory. */
	undo?: (record: UndoRecord) => void;
}

/** What one run needs from its host. The optional parts have browser defaults; tests always pass them. */
export interface AgentDeps {
	/** The mounting app's workspace, guides, scaffolding and dev sessions. */
	host: AgentHost;
	/** The connected RocketRide client, or null when there is none. */
	client: ClientGetter;
	/** Asks the model one question (default: the LLM pipeline behind `options.token`). */
	model?: ModelCall;
	/** Asks the user what to do with unsaved changes the agent wants to change (default: the three-button dialog). */
	choose?: ChoiceFn;
	/** Gets Monaco's marker source, or null when there is none (default: the editor's, loaded once). */
	markers?: () => Promise<MarkerSource | null>;
	/** The installed host's scope now, which a team switch changes (default: the installed host's). */
	currentScope?: () => string | undefined;
}

// =============================================================================
// MARKERS — the editor's marker source, loaded once and never in the way
// =============================================================================

/**
 * Wraps a marker source loader so a save or a check is never held up by it: the
 * load runs once and is shared, a failed load resolves null and retries next call,
 * and a load still going after `limitMs` resolves null for that call only.
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
 * accepts an answer. Only tool results write to it. Per target:
 * - A changed app needs a passing check_app in a wave after its last change. A
 *   failed, errored or late check_app leaves it unchecked; a step that did not
 *   run counts as a pass.
 * - A changed pipeline must not have failed validate on its latest save (every
 *   save validates). Delete drops it; rename carries its result.
 * - Any other change needs nothing.
 * A change is any CHANGE_TOOLS call, even a failed one, since a write may land
 * before its error. Deleting an app folder drops its record; renaming moves it.
 */
export class CheckRecord implements FinishRule {
	readonly checkTool = APP_CHECK_TOOL;
	/** Whether any call changed the work, even one that failed. */
	changed = false;

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
	 */
	beginWave(wave: number): void {
		this.wave = wave;
	}

	/**
	 * Records a check_app report (AppCheckToolkit's callback).
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
	 */
	pipelineSaved(path: string, validation: SaveValidation): void {
		this.pipelines.set(path, validation);
	}

	/**
	 * Hears a wave's calls: each change marks what it touched, and a check_app
	 * that errored or ended late voids its app's pass.
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
	 * Builds the checks line from the newest result per target; the model never
	 * writes or edits it.
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

	/**
	 * The newest result per target and step, for the turn result. An app the
	 * run changed and never checked has one check_app entry that did not run.
	 *
	 * @returns The checks, apps first.
	 */
	results(): TurnCheck[] {
		const out: TurnCheck[] = [];
		for (const [folder, app] of this.apps) {
			if (!app.report) {
				if (app.changed >= 0) out.push({ target: folder, step: APP_CHECK_TOOL, status: 'not_run', summary: 'not checked' });
				continue;
			}
			for (const e of app.report.evidence) out.push({ target: app.report.target, step: e.step, status: e.status, summary: e.summary });
		}
		for (const [path, v] of this.pipelines) {
			if ('failed' in v) out.push({ target: path, step: 'validate', status: 'not_run', summary: 'validate not run' });
			else out.push({ target: path, step: 'validate', status: v.errors.length === 0 ? 'pass' : 'fail', summary: v.errors.length === 0 ? 'validate OK' : `validate: ${v.errors.length} ${v.errors.length === 1 ? 'error' : 'errors'}` });
		}
		return out;
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
	 * Moves what a rename took along: an app folder stays recorded (as changed) only
	 * if still directly under `apps/`, a pipeline only if still a `.pipe` file.
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

/** A path argument spelled the way the file tools spell it; null for one they refuse (that call touched nothing). */
function canonical(raw: unknown): string | null {
	try {
		return normalizePath(raw);
	} catch {
		return null;
	}
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

// =============================================================================
// HISTORY AND ANSWER
// =============================================================================

/**
 * Turns the chat's messages into the model's history: user requests and the
 * agent's answers. Thinking, error, system and status rows are dropped, except
 * the Undo row, which the model reads as the user's since the files changed.
 * Consecutive user rows merge so roles alternate. Every row passes through
 * redactText: the chat still shows a pasted key, and older sessions may hold one.
 */
function toHistory(messages: ChatMessage[]): HistoryTurn[] {
	const turns: HistoryTurn[] = [];
	for (const m of messages) {
		const last = turns.at(-1);
		const text = redactText(m.text);
		const users = m.sender === 'user' || (m.sender === 'system' && m.text.startsWith(UNDO_ROW));
		if (users && last?.role === 'user') last.content = `${last.content}\n\n${text}`;
		else if (users) turns.push({ role: 'user', content: text });
		else if (m.sender === 'bot' && !m.isError && !m.resultKey) turns.push({ role: 'assistant', content: text });
	}
	return turns;
}

/** Whether a line starts with "Checked:" or "Not checked:" past list, quote and emphasis markers. */
function isChecksLine(line: string): boolean {
	return CHECKS_LINE.test(line.replace(LEADING_MARKDOWN, ''));
}

/**
 * The text the user reads: the model's answer, the code-built checks line, then
 * a warning when the run changed work and stopped before finishing (an asking
 * turn gets it only when something is still unchecked). Answer lines starting
 * "Checked:" or "Not checked:" are dropped, because only the code writes those.
 */
function finalText(result: LoopResult, checks: CheckRecord, shown: (text: string) => string): string {
	const answer = result.answer
		.split('\n')
		.filter((line) => !isChecksLine(line))
		.join('\n')
		.trim();
	const parts = [answer, checks.checksLine()];
	const unchecked = result.stopReason === 'needs_input' ? checks.unchecked() !== null : result.stopReason !== 'done';
	if (checks.changed && unchecked) parts.push(NOT_CHECKED);
	return shown(parts.filter((part) => part.length > 0).join('\n\n'));
}

/**
 * A "Needs your OK" card with its title and detail passed through `shown`: card
 * text comes from model arguments and server names, and the answered card's
 * status row copies the title into the thread, saved session and later history.
 */
function redactCard(card: ChatAskCard, shown: (text: string) => string): ChatAskCard {
	return { ...card, title: shown(card.title), detail: card.detail === undefined ? undefined : shown(card.detail) };
}

/**
 * A needs-you request with its question and choices passed through `hide`, so a
 * value the file tools hid shows as its marker on the card and in the session.
 * The kind, id and a Variable's name stay as they are: the card acts on them,
 * and a hidden value can be any word.
 */
function hideRequest(request: NeedsInputRequest, hide: (text: string) => string): NeedsInputRequest {
	return { ...request, question: hide(request.question), ...(request.choices ? { choices: request.choices.map((choice) => hide(choice)) } : {}) };
}

/**
 * The note that tells the model, at the top of a wave, which files it read
 * or wrote someone else changed since. Each change is named once.
 */
function changedFilesNote(tracker: FileTracker, vfs: { version(path: string): number; lastWriter(path: string): string | undefined }): () => string[] {
	const named = new Map<string, number>();
	return () => {
		const changed = tracker.changedSince(vfs).filter((file) => named.get(file.path) !== vfs.version(file.path));
		if (changed.length === 0) return [];
		for (const file of changed) named.set(file.path, vfs.version(file.path));
		const files = changed.map((file) => {
			const writer = vfs.lastWriter(file.path);
			return writer ? `${file.path} (${writer})` : file.path;
		});
		return [`Files changed since you last read them: ${files.join(', ')}. Read them again before editing.`];
	};
}

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
 * A provider that fails does not make `client.chat` throw: the LLM pipeline
 * answers with text starting "**LLM error** —". This section turns that, a dead
 * token and an empty reply into errors the loop shows as a banner.
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
	 * @returns The pipeline result, with the model's text in `answers`. Its other
	 *   fields depend on the pipeline; the index signature lets the client's
	 *   `PIPELINE_RESULT` fit, which an all-optional type would refuse.
	 */
	chat(o: { token: string; question: unknown }): Promise<{ answers?: unknown[]; [field: string]: unknown }>;
}

/** What createChatModel needs from its host. */
export interface ChatModelOptions {
	client: () => ChatClient | null;
	/** The token of the running LLM pipeline. Read again after a restart, since a new pipeline has a new token. */
	token: () => Promise<string>;
	/** Turns a question into whatever `client.chat` takes. */
	toQuestion: (q: QuestionSpec) => unknown;
	/** Restarts the LLM pipeline. Called once per model call, when the pipeline fails the first time. */
	onPipelineError?: () => Promise<void>;
	/** Aborted when the user stops the run: a call that fails after it neither restarts the pipeline nor retries. */
	signal?: AbortSignal;
	/** Reserves each request before it is sent, the retry after a restart included, and takes what it used. */
	meter?: UsageMeter;
}

/**
 * Builds the model call the Wave loop uses. It resolves with the model's text or
 * rejects: no client with a plain Error, a cost-limit refusal with
 * CostLimitError, anything else with a ModelError. A pipeline failure gets one
 * restart (`onPipelineError`) and one retry. Once the run is stopped a failure
 * gets no restart: it would end the pipeline the next turn is about to use.
 * Each request, retry included, is reserved on the meter just before it is
 * sent; a failed request keeps its reservation.
 */
export function createChatModel(o: ChatModelOptions): ModelCall {
	return async (q) => {
		const client = o.client();
		if (!client) throw new Error(NOT_CONNECTED_MESSAGE);
		const question = o.toQuestion(q);

		const ask = async (): Promise<{ answers?: unknown[] }> => {
			const token = await o.token();
			const held = o.meter?.reserve(q);
			try {
				const result = await client.chat({ token, question });
				const text = replyText(result);
				if (text.startsWith(LLM_ERROR_PREFIX)) held?.keep();
				else held?.settle(text.length);
				return result;
			} catch (error) {
				held?.keep();
				throw error;
			}
		};

		const started = performance.now();
		try {
			let result: { answers?: unknown[] };
			try {
				result = await ask();
			} catch (first) {
				// step: a request the cost limit refused was never sent, so there is nothing to restart
				if (first instanceof CostLimitError) throw first;
				if (!o.onPipelineError || o.signal?.aborted) throw pipelineError(first);
				try {
					await o.onPipelineError();
					result = await ask();
				} catch (second) {
					throw second instanceof CostLimitError ? second : pipelineError(second);
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

/** The text a pipeline result answers with; '' for none. */
function replyText(result: { answers?: unknown[] }): string {
	const first = result.answers?.[0];
	return typeof first === 'string' ? first : first == null ? '' : JSON.stringify(first);
}

/** Pulls the model's text out of a pipeline result, or throws the error it stands for. */
function answerText(result: { answers?: unknown[] }): string {
	const text = replyText(result);
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
 * Builds the client's Question from a spec. This is the agent's only runtime
 * import of 'rocketride', which is undefined under shared:test, so tests pass a
 * fake `toQuestion` to createChatModel instead.
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

/** Meters a model a test passes; createChatModel meters its own requests. */
function metered(call: ModelCall, meter: UsageMeter): ModelCall {
	return async (q) => {
		const held = meter.reserve(q);
		try {
			const text = await call(q);
			held.settle(text.length);
			return text;
		} catch (error) {
			held.keep();
			throw error;
		}
	};
}

// =============================================================================
// RUN
// =============================================================================

/**
 * Runs the agent once on a request: `thinking` chunks per wave, then one
 * `content` chunk with the answer (none when stopped).
 * @param deps - The host, the client getter, and the parts tests replace.
 * @throws A TurnError when the model fails before the run gathered anything.
 */
export async function runAgent(request: string, callback: (type: string, content: string) => void, options: AgentRunOptions, deps: AgentDeps): Promise<TurnResult> {
	const { host, client } = deps;
	const turnId = options.turnId ?? crypto.randomUUID();
	// step: the turn's limits, read once; the meter counts every model request sent, so a turn that throws still reports them
	const limits = host.limits?.read() ?? DEFAULT_LIMITS;
	const meter = new UsageMeter({ model: options.model, limitUsd: limits.costUsd });
	const model: ModelCall = deps.model ? metered(deps.model, meter) : createChatModel({ client, token: options.token, toQuestion: toRocketRideQuestion, onPipelineError: options.onPipelineError, signal: options.signal, meter });
	const choose = deps.choose ?? shellChoice();
	const markers = deps.markers ?? editorMarkers;

	// step: the record of check results, which is also the loop's finish rule; it names an app the way check_app does
	const checks = new CheckRecord(async (ref) => {
		try {
			return findApp(await readApps(host.vfs, () => false), ref.trim()).folder;
		} catch {
			return null;
		}
	});

	// step: the workspace; every save that works returns the types of an app's TypeScript file
	// or the validate of a pipeline, and the validate is recorded for the finish rule
	const { vfs } = host;
	// step: the runs the conversation started; a fresh use adds one, and Auto stops or restarts only those
	const scopeKey = host.scopeKey ?? '';
	const currentScope = deps.currentScope ?? (() => findAgentHost()?.scopeKey);
	const ledger = new RunLedger(options.runs ?? [], { client, scopeKey, currentScope: () => currentScope() ?? '', conversationId: options.conversationId ?? '' });
	// step: the run's approvals; the toolkits and the save hook below get its checked client,
	// and every card it shows is redacted on its way to the chat
	const { ask } = options;
	const approvals = new Approvals({ client, vfs, ask: ask && ((card) => ask(redactCard(card, shown))), settings: host.approvals?.run, signal: options.signal, runs: ledger });
	const afterSave = async (path: string): Promise<string> => {
		const appFile = APP_TYPESCRIPT_FILE.exec(path);
		if (appFile) return typesNote(vfs, markers, appFile[1], appFile[2], hide);
		if (!path.endsWith('.pipe')) return '';
		const validation = await validateSaved(approvals.client, vfs, path);
		checks.pipelineSaved(path, validation);
		return validateNote(validation, hide);
	};

	// step: the toolkits in mount order; one file toolkit per run, so reads never carry over. An
	// unsaved-changes question pauses tool time limits and closes as Keep mine when the run ends
	const editor = host.editor?.bind(host);
	const userTime = new UserTime();
	const runEnded = new AbortController();
	const endOnStop = (): void => runEnded.abort();
	options.signal.addEventListener('abort', endOnStop, { once: true });
	if (options.signal.aborted) runEnded.abort();
	const askUnsaved: ChoiceFn = (title, message) => userTime.during(choose(title, message, runEnded.signal));
	const files = new FilesystemTools(vfs, undefined, afterSave, editor ? { choose: askUnsaved, editor } : undefined);
	// step: a toolkit cuts a long text before the loop sees it, and a cut value no longer matches,
	// so each one, and the save hook above, hides the values the file tools hid before it cuts
	const hide = (text: string): string => files.secrets.hideKnown(text);
	const askUser = new AskUserToolkit(approvals.client);
	const composed = composeToolkits([
		files,
		new InventoryToolkit(vfs, (id) => host.devSession(id) !== null),
		new RocketRideClientToolkit(approvals.client, vfs, hide, ledger),
		// a scaffold writes files the Undo record does not hold, so a turn that creates an app cannot be undone
		new AppToolkit(approvals.client, host, { signal: options.signal, hide, created: (path) => files.tracker.created(path), onScaffold: () => files.undo.unavailable('this turn created an app') }),
		new AppCheckToolkit(host, markers, (folder, report) => checks.appChecked(folder, report), { signal: options.signal, hide }),
		askUser,
	]);
	// step: cards and the answer hold text the loop never saw (a server's names, check_app's summaries),
	// so each value the file tools hid shows as its marker there too; a card asks only once the loop runs
	const shown = (text: string): string => redactText(hide(text));

	// step: what the turn did, read when it ends, however it ends
	let paused: NeedsInputRequest | undefined;
	const usageOf = (waves: number, toolCalls: number): TurnUsage => {
		const used = meter.snapshot();
		return {
			waves,
			modelRequests: used.requests,
			toolCalls,
			...(used.requests > 0 ? { tokens: { input: used.inputTokens, output: used.outputTokens, estimated: true } } : {}),
			...(used.usd !== undefined ? { cost: { usd: used.usd, estimated: true } } : {}),
		};
	};
	const turnOf = (outcome: Pick<TurnResult, 'outcome' | 'reason' | 'finalText' | 'error'>, waves: number, toolCalls: number): TurnResult => {
		const undo = files.undo.state();
		// a Stopped card never shows the question, so only a needs-you turn has a request to answer
		const request = outcome.outcome === 'needs_input' ? (askUser.request ?? paused) : undefined;
		return redactDeep({
			turnId,
			...(host.scopeKey !== undefined ? { scopeKey: host.scopeKey } : {}),
			...outcome,
			files: files.tracker.changes(),
			checks: checks.results(),
			usage: usageOf(waves, toolCalls),
			...(request ? { request: hideRequest(request, hide) } : {}),
			...(ledger.started.length ? { runsStarted: [...ledger.started] } : {}),
			...(undo === 'none' ? {} : { undoAvailable: typeof undo !== 'object' }),
		});
	};

	let result: LoopResult;
	try {
		result = await runLoop({
			// execute holds back only a sure key shape, so a bearer token or a secret field still reaches here
			request: redactText(request),
			history: toHistory(options.history),
			prefix: buildPrefix(CORE_PROMPT, options.prompts, composed),
			tools: composed.tools,
			model,
			finish: checks,
			emit: (type, text) => callback(type, text),
			timeoutMs: (tool) => (tool === 'deploy_app' ? DEPLOY_APP_TIMEOUT_MS : TOOL_TIMEOUT_MS),
			signal: options.signal,
			takeQueued: options.takeQueued,
			approve: (act, run) => approvals.approve(act, run),
			secrets: files.secrets,
			notes: changedFilesNote(files.tracker, vfs),
			userTime,
			endTurn: () => askUser.request?.question ?? null,
			withdrawAsk: () => {
				askUser.request = null;
			},
			maxWaves: limits.steps,
		});
	} catch (error) {
		// step: nothing was gathered, so the chat shows the model's error; the result says what the turn got to
		const message = error instanceof Error ? error.message : String(error);
		throw new TurnError(message, turnOf({ outcome: 'failed', reason: 'error', finalText: '', error: message }, 1, 0));
	} finally {
		options.signal.removeEventListener('abort', endOnStop);
		runEnded.abort();
		options.undo?.(files.undo);
	}

	// step: a limit paused the turn: it asks the user to continue, in a new turn with a fresh budget
	if (result.stopReason === 'limited' || result.stopReason === 'cost_limit') {
		const question = result.stopReason === 'limited' ? `Paused after ${result.waves} ${result.waves === 1 ? 'step' : 'steps'}` : `Paused at the cost limit of ${dollars(meter.limitUsd)}`;
		paused = { id: crypto.randomUUID().slice(0, 8), kind: 'continue', question };
	}

	// step: a stopped run writes no answer: the chat closes the turn with its stop row, and this adds the one fact that row can't know
	const text = result.stopReason === 'stopped' ? '' : finalText(result, checks, shown);
	if (result.stopReason !== 'stopped') callback('content', text);
	else if (checks.changed) callback('thinking', NOT_CHECKED);
	console.log(`[agent] stop=${result.stopReason} waves=${result.waves} modelCalls=${result.modelMs.length} medianMs=${median(result.modelMs)} guides=[${files.pathsSeen().filter(isReferencePath).join(',')}]`);
	return turnOf({ outcome: outcomeOf(result.stopReason), reason: result.stopReason, finalText: text }, result.waves, result.toolCalls);
}
