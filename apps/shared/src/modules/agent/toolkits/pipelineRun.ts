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
// PIPELINE RUN TOOLS — run, send, monitor, terminate, list and the run log
// =============================================================================

/**
 * The tools the model runs a pipeline and reads its result with. They take the
 * MCP names and argument names (`packages/ai/src/ai/modules/mcp/tools/execution.py`,
 * `visibility.py` and `logs.py`) so the pipeline skills read correctly. Results
 * are text, cut when long, with secrets stripped.
 *
 * "Validate before run" is enforced here, not only stated: `run_pipeline`
 * validates first and does not start a pipeline the engine finds errors in.
 *
 * Every result that carries a run's token returns it under `task_token`, the one
 * secret-named key the secret stripper keeps. `send_files` and `run_dropper_pipe`
 * are left out: files cannot reach the tab's agent.
 */

import type { LogStreamRef, PipelineConfig, RocketRideClient, TASK_STATUS } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';
import { firstText, messageOf, numberArg, pipelineArg, requireClient, sleep, sourceIdOf, textArg, toolText, type ClientGetter } from './common';
import { validatePipeline } from './pipelineDesign';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The type every input is sent as. */
const INPUT_MIMETYPE = 'text/plain';

/** The message when a call has no task token. */
const NEED_TOKEN = 'Pass task_token: the value run_pipeline returned (list_running_pipelines shows the live ones).';

/** The message when a log call has no stream address. */
const NEED_STREAM = 'Pass projectId and source, as run_pipeline returned them.';

/** What a failed log read adds: runs do not last. */
const RETENTION_HINT = 'runs expire after 7 days (dev) or 30 days (deploy), so run the pipeline again for a fresh log.';

/** The engine's refusal of a second run of a live task (`task_server.py`: "Pipeline is already running."). */
const ALREADY_RUNNING = /already running/i;

/** What to do when the pipeline is already running: the fix is not another validation. */
const RERUN_GUIDANCE = 'To run your edited version, call list_running_pipelines, terminate that task_token, then call run_pipeline again. To reuse the running task unchanged (your edits are not applied to it), pass use_existing: true.';

/** What each task state is called. The numbers are the engine's `TASK_STATE`, kept here because the enum is not importable under the test runner. */
const STATE_LABELS: Record<number, string> = { 0: 'none', 1: 'starting', 2: 'initializing', 3: 'running', 4: 'stopping', 5: 'completed', 6: 'cancelled' };

/** The states a task does not leave: completed and cancelled. */
const TERMINAL_STATES = new Set([5, 6]);

/** How long `monitor` waits by default, in seconds. */
const MONITOR_TIMEOUT_S = 30;

/**
 * The longest `monitor` waits, in seconds, so one call cannot hold the turn open.
 * It stays under the loop's 300 s limit per tool call (`TOOL_TIMEOUT_MS` in
 * `wave/loop.ts`), so a wait at the maximum still returns its status in time.
 */
const MONITOR_MAX_TIMEOUT_S = 240;

/** The default wait between polls, in seconds. */
const MONITOR_INTERVAL_S = 1;

/** The shortest wait between polls, in seconds, so `monitor` does not hammer the engine. */
const MONITOR_MIN_INTERVAL_S = 0.25;

/** The least time one status call is given, in milliseconds. */
const STATUS_CALL_MIN_MS = 5000;

/** The most events one `log_read` page holds. */
const LOG_MAX_EVENTS = 200;

/** The most bytes one `log_read` page holds: 200 events of 64 KiB values is far past what the model can read. */
const LOG_MAX_BYTES = 1_048_576;

/** How many traces `log_traces` gives by default. */
const TRACES_DEFAULT_N = 20;

/** The most traces `log_traces` gives; the event stream refuses more. */
const TRACES_MAX_N = 50;

/** What every log tool says about its key arguments. */
const LOG_KEY_PROPERTIES = {
	projectId: { type: 'string', description: 'Pipeline project id, as run_pipeline returned it' },
	source: { type: 'string', description: 'Source component id, as run_pipeline returned it' },
	teamId: { type: 'string', description: "Team id, to read that team's deploy log; omit for your own runs" },
};

// =============================================================================
// ARGUMENTS
// =============================================================================

/**
 * Keeps a number inside a range.
 *
 * @param value - The number.
 * @param min - The least allowed.
 * @param max - The most allowed.
 * @returns The number, moved to the nearest end if it is outside.
 */
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * The task token the call names.
 *
 * @param args - The tool arguments.
 * @returns The token.
 * @throws When there is none; `token` is not accepted, so the model learns the one name.
 */
function tokenArg(args: Record<string, unknown>): string {
	const token = textArg(args, 'task_token');
	if (!token) throw new Error(NEED_TOKEN);
	return token;
}

/**
 * The run-log stream a call addresses.
 *
 * @param args - The tool arguments.
 * @returns The stream: project, source and, when given, the team whose deploy log to read.
 * @throws When the project or source is missing.
 */
function streamArg(args: Record<string, unknown>): LogStreamRef {
	const projectId = textArg(args, 'projectId');
	const source = textArg(args, 'source');
	if (!projectId || !source) throw new Error(NEED_STREAM);
	const teamId = textArg(args, 'teamId');
	return teamId ? { projectId, source, teamId } : { projectId, source };
}

/**
 * The inputs a run sends.
 *
 * @param args - The tool arguments.
 * @returns The texts to send, one send each (empty when none were given), and whether they came as one text rather than a list.
 * @throws When an input is not text.
 */
function inputsArg(args: Record<string, unknown>): { list: string[]; single: boolean } {
	const raw = args.inputs;
	if (raw === undefined || raw === null) return { list: [], single: false };
	const list: unknown[] = Array.isArray(raw) ? raw : [raw];
	if (!list.every((item): item is string => typeof item === 'string')) throw new Error('inputs must be text, or a list of texts. Pass each input as a string.');
	return { list, single: !Array.isArray(raw) };
}

/**
 * A true-or-false argument.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @returns The value; undefined when the argument is absent.
 * @throws When the argument is not true or false.
 */
function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
	const raw = args[key];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'boolean') throw new Error(`${key} must be true or false.`);
	return raw;
}

// =============================================================================
// RUN
// =============================================================================

/**
 * Validates a pipeline and starts it, then sends each input.
 *
 * @param getClient - The host's client getter.
 * @param args - The `run_pipeline` arguments.
 * @param vfs - The workspace view a `path` is read from.
 * @returns The result text: the task token and the log address, plus the result of each input (`result` for one text, `results` for a list).
 * @throws Before anything starts, when an argument is wrong or validation finds errors; after the start, when an input cannot be sent (the message names the task).
 */
async function runPipeline(getClient: ClientGetter, args: Record<string, unknown>, vfs: IWorkspaceFileSystem): Promise<string> {
	// Check every argument first: a bad one must not leave a started run behind.
	const { list: inputs, single } = inputsArg(args);
	const ttl = numberArg(args, 'ttl', true);
	if (ttl !== undefined && ttl < 0) throw new Error('ttl must be a whole number of seconds, 0 or more (0 for no timeout).');
	const useExisting = booleanArg(args, 'use_existing');
	const source = textArg(args, 'source') || undefined;
	const { pipeline } = await pipelineArg(args, vfs);
	const client = requireClient(getClient);

	const { errors } = await validatePipeline(client, pipeline);
	if (errors.length > 0) {
		throw new Error(`Not started: validate_pipeline found ${errors.length} error(s):\n${errors.map((error) => `- ${error}`).join('\n')}\nFix these, then call run_pipeline again.`);
	}

	let started: Awaited<ReturnType<RocketRideClient['use']>>;
	try {
		started = await client.use({
			pipeline: pipeline as unknown as PipelineConfig,
			...(source !== undefined ? { source } : {}),
			...(ttl !== undefined ? { ttl } : {}),
			...(useExisting !== undefined ? { useExisting } : {}),
			// Without a trace level, log_traces has nothing to show.
			pipelineTraceLevel: 'summary',
		});
	} catch (err) {
		// The engine refuses a second run of a live task: the token is a hash of owner, project and source, so an
		// edited pipeline collides with its own earlier run. Validation just passed, so it is not the fix.
		if (ALREADY_RUNNING.test(messageOf(err))) throw new Error(`Not started: ${messageOf(err)}. ${RERUN_GUIDANCE}`);
		throw new Error(`Not started: the pipeline passed validation, but the engine refused to start it: ${messageOf(err)}. Fix what that reason names (for example a missing Variable), then call run_pipeline again, or tell the user if you can't fix it.`);
	}
	const token = firstText(started?.token);
	if (!token) throw new Error('Not started: the engine returned no task token. Run validate_pipeline and fix what it reports, then try again.');

	const results: unknown[] = [];
	for (const [index, input] of inputs.entries()) {
		try {
			results.push((await client.send(token, input, {}, INPUT_MIMETYPE)) ?? null);
		} catch (err) {
			throw new Error(`The pipeline started (task_token ${token}) but input ${index + 1} of ${inputs.length} failed to send: ${messageOf(err)}. Call send_data to try again, or terminate to stop the run.`);
		}
	}

	return toolText(
		{
			ok: true,
			task_token: token,
			projectId: firstText(started.projectId, started.project_id, pipeline.project_id),
			source: firstText(started.source, source, sourceIdOf(pipeline)),
			// The reused flag is the engine's: it did not apply the pipeline just sent.
			...(started.reused === true ? { reused: true, note: 'Reused the running task: the pipeline you sent was not applied to it. To run your edits, terminate it and run again.' } : {}),
			// One text in, one answer out (the MCP shape); a list gets a list.
			...(inputs.length > 0 ? (single ? { result: results[0] } : { results }) : {}),
		},
		'send fewer inputs per call; log_read shows the rest of what the run did'
	);
}

/**
 * Sends one input to a running pipeline.
 *
 * @param client - The connected client.
 * @param args - The `send_data` arguments.
 * @returns The result text.
 */
async function sendData(client: RocketRideClient, args: Record<string, unknown>): Promise<string> {
	const token = tokenArg(args);
	const input = args.input;
	if (typeof input !== 'string') throw new Error('Pass input: the text to send to the running pipeline.');

	let result: unknown;
	try {
		result = await client.send(token, input, {}, INPUT_MIMETYPE);
	} catch (err) {
		throw new Error(`Cannot send to task '${token}': ${messageOf(err)}. list_running_pipelines shows the live tasks.`);
	}
	return toolText({ ok: true, result: result ?? null }, 'send less per call; log_read shows the rest of what the run did');
}

/**
 * Stops a running pipeline.
 *
 * @param client - The connected client.
 * @param args - The `terminate` arguments.
 * @returns The result text.
 */
async function terminate(client: RocketRideClient, args: Record<string, unknown>): Promise<string> {
	const token = tokenArg(args);
	try {
		await client.terminate(token);
	} catch (err) {
		throw new Error(`Cannot terminate task '${token}': ${messageOf(err)}. list_running_pipelines shows the live tasks.`);
	}
	return toolText({ ok: true, task_token: token, terminated: true }, 'list_running_pipelines shows what is still running');
}

// =============================================================================
// MONITOR
// =============================================================================

/**
 * The part of a status the model needs, with the small fields first so a cut
 * long error list cannot hide them.
 *
 * @param token - The task token.
 * @param status - The engine's status for the task.
 * @param polls - How many times the status has been read.
 * @param timeoutS - The seconds `monitor` was willing to wait, for the note.
 * @returns The snapshot.
 */
function snapshotOf(token: string, status: Partial<TASK_STATUS>, polls: number, timeoutS: number): Record<string, unknown> {
	const state = typeof status.state === 'number' ? status.state : 0;
	const completed = Boolean(status.completed);
	const terminal = completed || TERMINAL_STATES.has(state);
	const label = STATE_LABELS[state] ?? 'none';
	return {
		ok: true,
		task_token: token,
		state,
		state_label: label,
		completed,
		terminal,
		message: status.status,
		counts: { completedCount: status.completedCount ?? 0, failedCount: status.failedCount ?? 0, totalCount: status.totalCount ?? 0 },
		...(terminal ? { exitCode: status.exitCode, exitMessage: status.exitMessage } : { note: `Still ${label} after ${timeoutS} seconds. Call monitor again to keep waiting, or terminate to stop it; a source that waits for input (chat, webhook) never finishes by itself.` }),
		polls,
		errors: status.errors ?? [],
		warnings: status.warnings ?? [],
	};
}

// =============================================================================
// LIST
// =============================================================================

/**
 * A task token without its auth prefix, the form its display id starts from.
 *
 * @param token - A task token.
 * @returns The token without `tk_` or `pk_`.
 */
function bareToken(token: string): string {
	return token.replace(/^(?:tk_|pk_)/, '');
}

/**
 * The token of a listed task. The list gives only a task's display id (the first
 * eight characters of its token and its source), so the token is looked up by
 * project and source, and kept only when it belongs to this very task: the same
 * pipeline run by someone else has another token.
 *
 * @param client - The connected client.
 * @param row - One row of the engine's task list.
 * @returns The token; undefined when the task has ended, is not the caller's, or cannot be looked up.
 */
async function liveTokenOf(client: RocketRideClient, row: Awaited<ReturnType<RocketRideClient['listTasks']>>['rows'][number]): Promise<string | undefined> {
	if (row.completed || typeof row.id !== 'string') return undefined;
	try {
		const token = await client.getTaskToken({ projectId: row.projectId, source: row.source });
		return token && bareToken(token).startsWith(row.id.slice(0, 8)) ? token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The running tasks, each with the token to follow it.
 *
 * @param client - The connected client.
 * @returns The result text.
 */
async function listRunning(client: RocketRideClient): Promise<string> {
	const { rows, total } = await client.listTasks();
	const tasks = await Promise.all(
		rows.map(async (row) => {
			const token = await liveTokenOf(client, row);
			return {
				...(token ? { task_token: token } : {}),
				name: row.name,
				projectId: row.projectId,
				source: row.source,
				state: STATE_LABELS[row.state] ?? 'none',
				completed: row.completed,
				message: row.status,
				exitCode: row.exitCode,
				elapsedTime: row.elapsedTime,
				ttl: row.ttl,
				completedCount: row.completedCount,
				totalCount: row.totalCount,
			};
		})
	);
	return toolText({ ok: true, count: tasks.length, total, tasks }, 'only the first tasks are shown; terminate the runs you no longer need');
}

// =============================================================================
// RUN LOG
// =============================================================================

/** An open event stream over one run log. */
type EventStream = ReturnType<RocketRideClient['log']['openEventStream']>;

/**
 * Runs a log read and rewords a failure so the model knows what to try.
 *
 * @param what - What was being read, for the message ("read the run log").
 * @param advice - How to fix the call, for the message.
 * @param read - The read.
 * @returns What the read returned.
 * @throws With the engine's reason, the advice and the retention rule.
 */
async function logRead<T>(what: string, advice: string, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (err) {
		throw new Error(`Cannot ${what}: ${messageOf(err)}. ${advice}; ${RETENTION_HINT}`);
	}
}

/**
 * Opens an event stream over a run log, runs a read on it and closes it.
 *
 * @param client - The connected client.
 * @param stream - The run log to open.
 * @param read - The read to run on the open stream.
 * @returns What the read returned.
 */
async function withEventStream<T>(client: RocketRideClient, stream: LogStreamRef, read: (events: EventStream) => Promise<T>): Promise<T> {
	const events = client.log.openEventStream(stream);
	try {
		return await read(events);
	} finally {
		events.closeEventStream();
	}
}

/**
 * Where on the log to read traces: the end of a past run, or now.
 *
 * @param client - The connected client.
 * @param stream - The run log.
 * @param chapterBeginSeq - The first seq of the run, from `log_chapters`.
 * @returns The end time of that run in epoch seconds; 'live' when it has not ended.
 * @throws When no run begins at that seq.
 */
async function chapterEnd(client: RocketRideClient, stream: LogStreamRef, chapterBeginSeq: number): Promise<number | 'live'> {
	const { chapters } = await logRead('list the runs', 'Use the projectId and source that run_pipeline returned', () => client.log.chapters(stream));
	const chapter = chapters.find((c) => c.beginSeq === chapterBeginSeq);
	if (!chapter) throw new Error(`No run begins at seq ${chapterBeginSeq}. log_chapters lists the runs with their beginSeq.`);
	return chapter.endTime ?? 'live';
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The pipeline run toolkit: run, send, monitor, terminate, list and the four run-log tools. */
export class PipelineRunToolkit extends AgentToolkit {
	readonly name = 'pipeline-run';
	readonly instructions = 'Run a pipeline with run_pipeline, which validates first. Watch it with monitor until terminal is true, and read its console and traces with log_read and log_traces, because a run counts as passed only when a tool result shows it.';

	/** Returns the connected client, or null. */
	private readonly client: ClientGetter;
	/** The workspace view a `path` is read from. */
	private readonly vfs: IWorkspaceFileSystem;
	/** The wait between `monitor` polls in milliseconds, replacing the `interval` argument; undefined to honour `interval`. */
	private readonly pollMs: number | undefined;

	/**
	 * Builds the toolkit.
	 *
	 * @param client - The host's client getter.
	 * @param vfs - The workspace view.
	 * @param opts - `pollMs`: the wait between `monitor` polls, in milliseconds. Tests pass 0 so polling does not wait.
	 */
	constructor(client: ClientGetter, vfs: IWorkspaceFileSystem, opts: { pollMs?: number } = {}) {
		super();
		this.client = client;
		this.vfs = vfs;
		this.pollMs = opts.pollMs;
	}

	/**
	 * Watches a task until it ends or the timeout passes.
	 *
	 * @param args - The `monitor` arguments.
	 * @returns The last status snapshot.
	 */
	private async monitor(args: Record<string, unknown>): Promise<string> {
		const token = tokenArg(args);
		const timeoutS = clamp(numberArg(args, 'timeout') ?? MONITOR_TIMEOUT_S, 0, MONITOR_MAX_TIMEOUT_S);
		const intervalS = Math.max(MONITOR_MIN_INTERVAL_S, numberArg(args, 'interval') ?? MONITOR_INTERVAL_S);
		const waitMs = this.pollMs ?? intervalS * 1000;
		const client = requireClient(this.client);

		const deadline = Date.now() + timeoutS * 1000;
		for (let polls = 1; ; polls++) {
			let status: TASK_STATUS;
			try {
				status = await client.getTaskStatus(token, { timeout: Math.max(waitMs, STATUS_CALL_MIN_MS) });
			} catch (err) {
				throw new Error(`Cannot read the status of task '${token}': ${messageOf(err)}. The task may have ended or the token may be wrong (list_running_pipelines shows the live tasks), or the status call timed out (call monitor again).`);
			}
			const snapshot = snapshotOf(token, status ?? {}, polls, timeoutS);
			const remainingMs = deadline - Date.now();
			if (snapshot.terminal || remainingMs <= 0) return toolText(snapshot, 'log_read with types ["output"] shows the run console');
			// Never sleep past the deadline: the last look should be at the deadline.
			await sleep(Math.min(waitMs, remainingMs));
		}
	}

	/**
	 * The run tools.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'run_pipeline',
				description: [
					'Start a pipeline and return its task_token, projectId and source.',
					'- You MUST validate before run: this tool checks the pipeline first and does not start it when validate_pipeline finds errors, so fix them and run again.',
					'- Pass exactly one of path (a .pipe file in the workspace) or pipeline (the pipeline object).',
					'- Pass inputs (a text, or a list of texts) to send once it is up, one send each; one text comes back as result, a list as results.',
					'- Needs a connected RocketRide engine.',
					'- The run keeps going after this returns: follow it with monitor (task_token), read it with the log tools (projectId and source), and stop it with terminate.',
					'- A source that waits for input (chat, webhook) never finishes by itself; feed it with send_data.',
					'- Traces are recorded at the summary level, so log_traces has content.',
					'- Running a pipeline that is already running fails, because the engine allows one live task per pipeline: to run your edited version, call list_running_pipelines, terminate that task_token, then run again. To reuse the running task unchanged, pass use_existing: true (your edits are not applied to it).',
				].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace path of a .pipe file, for example pipelines/chat.pipe' },
						pipeline: { type: 'object', description: 'The pipeline object, flat or wrapped as in a .pipe file' },
						inputs: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Text to send once the pipeline is up, or a list of texts, one send each' },
						ttl: { type: 'integer', description: 'Seconds the idle task stays alive; 0 for no timeout. Omit for the engine default' },
						use_existing: { type: 'boolean', description: 'Reuse the pipeline already running instead of starting one; your edits are not applied to it' },
						source: { type: 'string', description: "Source component id to start from. Omit to use the pipeline's own source" },
					},
					additionalProperties: false,
				},
				execute: (args) => runPipeline(this.client, args, this.vfs),
			}),
			new AgentTool({
				name: 'send_data',
				description: ['Send text to a running pipeline and return its result.', '- Pass the task_token run_pipeline returned.', '- Needs a pipeline that is still running; an ended task fails.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						task_token: { type: 'string', description: 'Task token returned by run_pipeline' },
						input: { type: 'string', description: 'Text to send to the running task' },
					},
					required: ['task_token', 'input'],
					additionalProperties: false,
				},
				execute: async (args) => sendData(requireClient(this.client), args),
			}),
			new AgentTool({
				name: 'monitor',
				description: ['Poll a running pipeline until it ends or the timeout passes, and return its status.', '- terminal true means it ended: completed or cancelled, with exitCode, exitMessage, errors and warnings.', '- terminal false at the timeout means it is still going; call monitor again, or terminate it.', '- A source that waits for input (chat, webhook) never ends by itself.', '- If the status call times out, call monitor again.', '- Read errors and warnings before saying a run worked.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						task_token: { type: 'string', description: 'Task token returned by run_pipeline' },
						timeout: { type: 'number', minimum: 0, maximum: MONITOR_MAX_TIMEOUT_S, description: `Most seconds to wait before returning the current status (default ${MONITOR_TIMEOUT_S}, most ${MONITOR_MAX_TIMEOUT_S})` },
						interval: { type: 'number', minimum: MONITOR_MIN_INTERVAL_S, description: `Seconds between polls (default ${MONITOR_INTERVAL_S}, least ${MONITOR_MIN_INTERVAL_S})` },
					},
					required: ['task_token'],
					additionalProperties: false,
				},
				execute: (args) => this.monitor(args),
			}),
			new AgentTool({
				name: 'terminate',
				description: ['Stop a running pipeline by its task_token.', '- Use it to end a run you are done with or one that will not stop.', '- The run log stays readable after it ends.'].join('\n'),
				parameters: {
					type: 'object',
					properties: { task_token: { type: 'string', description: 'Task token returned by run_pipeline' } },
					required: ['task_token'],
					additionalProperties: false,
				},
				execute: async (args) => terminate(requireClient(this.client), args),
			}),
			new AgentTool({
				name: 'list_running_pipelines',
				description: ['List the pipelines on this engine with their task_token, name and state.', '- Use the task_token with monitor, send_data or terminate.', '- A task with no task_token has ended or is not yours.'].join('\n'),
				parameters: { type: 'object', properties: {}, additionalProperties: false },
				execute: async () => listRunning(requireClient(this.client)),
			}),
			new AgentTool({
				name: 'log_chapters',
				description: ['List the recorded runs of a pipeline: begin and end time, beginSeq and outcome.', '- Pass the projectId and source run_pipeline returned.', '- Works for past runs and the live one.', '- beginSeq is what log_traces takes as chapterBeginSeq.'].join('\n'),
				parameters: { type: 'object', properties: LOG_KEY_PROPERTIES, required: ['projectId', 'source'], additionalProperties: false },
				execute: async (args) => {
					const stream = streamArg(args);
					const client = requireClient(this.client);
					const result = await logRead('list the runs', 'Use the projectId and source that run_pipeline returned', () => client.log.chapters(stream));
					if (!result?.chapters?.length) throw new Error('No recorded runs for this projectId and source. Use the projectId and source that run_pipeline returned.');
					return toolText({ ok: true, chapters: result.chapters, horizonSeq: result.horizonSeq }, 'the list is long; log_read with fromSeq reads from a chosen run');
				},
			}),
			new AgentTool({
				name: 'log_read',
				description: ['Read raw run-log events of a pipeline, a page at a time.', '- Pass the projectId and source run_pipeline returned.', '- types ["output"] gives console lines only; use it first when a run failed.', '- Pass nextCursor back as cursor to read on.', `- A page holds at most ${LOG_MAX_EVENTS} events, and a long result is cut: narrow with types or maxEvents.`].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						...LOG_KEY_PROPERTIES,
						fromSeq: { type: 'integer', description: 'Sequence number to start reading from' },
						cursor: { type: 'integer', description: 'nextCursor from the previous page' },
						maxEvents: { type: 'integer', description: `Most events to return, at most ${LOG_MAX_EVENTS}` },
						types: { type: 'array', items: { type: 'string' }, description: 'Only these event types, for example ["output"] for console lines' },
					},
					required: ['projectId', 'source'],
					additionalProperties: false,
				},
				execute: async (args) => {
					const stream = streamArg(args);
					const fromSeq = numberArg(args, 'fromSeq', true);
					const cursor = numberArg(args, 'cursor', true);
					// A maxEvents of 0 means "not given", as in the MCP tool.
					const maxEvents = clamp(Math.trunc(numberArg(args, 'maxEvents') || LOG_MAX_EVENTS), 1, LOG_MAX_EVENTS);
					const types = args.types;
					if (types !== undefined && types !== null && !(Array.isArray(types) && types.every((t) => typeof t === 'string'))) {
						throw new Error('types must be a list of event types, for example ["output"].');
					}
					const client = requireClient(this.client);

					const page = await logRead('read the run log', 'Use the projectId and source that run_pipeline returned', () =>
						client.log.read(stream, {
							...(fromSeq !== undefined ? { fromSeq } : {}),
							...(cursor !== undefined ? { cursor } : {}),
							maxEvents,
							maxBytes: LOG_MAX_BYTES,
							...(Array.isArray(types) && types.length > 0 ? { types: types as string[] } : {}),
						})
					);
					return toolText({ ok: true, events: page?.events ?? [], nextCursor: page?.nextSeq, truncatedAtSeq: page?.truncatedAtSeq }, 'narrow with types or maxEvents');
				},
			}),
			new AgentTool({
				name: 'log_traces',
				description: ["List the traces of a pipeline's latest run: one summary per file or document that went through it, with its beginSeq.", '- Pass the projectId and source run_pipeline returned.', '- traces are the finished ones, open are still going.', '- Pass chapterBeginSeq (from log_chapters) for an earlier run.', '- log_trace takes a beginSeq and shows that trace in full.', `- Gives the latest n (default ${TRACES_DEFAULT_N}, at most ${TRACES_MAX_N}).`].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						...LOG_KEY_PROPERTIES,
						n: { type: 'integer', description: `Most traces to return (default ${TRACES_DEFAULT_N}, at most ${TRACES_MAX_N})` },
						chapterBeginSeq: { type: 'integer', description: 'beginSeq of an earlier run, from log_chapters; omit for the latest run' },
					},
					required: ['projectId', 'source'],
					additionalProperties: false,
				},
				execute: async (args) => {
					const stream = streamArg(args);
					// An n of 0 means "not given", as in the MCP tool.
					const n = clamp(Math.trunc(numberArg(args, 'n', true) || TRACES_DEFAULT_N), 1, TRACES_MAX_N);
					const chapterBeginSeq = numberArg(args, 'chapterBeginSeq', true);
					const client = requireClient(this.client);

					const position = chapterBeginSeq === undefined ? 'live' : await chapterEnd(client, stream, chapterBeginSeq);
					const found = await logRead('read the traces', 'Use the projectId and source that run_pipeline returned', () =>
						withEventStream(client, stream, async (events) => {
							await events.seek(position);
							return events.getTraces(n);
						})
					);
					// The stream answers "as of the end of that run", which can still hold the run before it.
					const ofRun = <T extends { beginSeq?: number }>(traces: T[]): T[] => (chapterBeginSeq === undefined ? traces : traces.filter((t) => t.beginSeq === undefined || t.beginSeq >= chapterBeginSeq));
					const traces = ofRun(found?.closed ?? []);
					const open = ofRun(found?.open ?? []);
					return toolText(
						{
							ok: true,
							traces,
							open,
							context: stream,
							...(traces.length === 0 && open.length === 0 ? { note: "no traces recorded — the run may have been started with pipelineTraceLevel 'none' (run_pipeline traces at the summary level)" } : {}),
						},
						'ask for a smaller n to see fewer traces'
					);
				},
			}),
			new AgentTool({
				name: 'log_trace',
				description: ['Show one trace in full: a summary, every component enter and leave with its lane data, and the messages each node logged.', '- Pass the projectId and source run_pipeline returned, and a beginSeq from log_traces.', '- A long trace is cut; log_read pages its raw events instead.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						...LOG_KEY_PROPERTIES,
						beginSeq: { type: 'integer', description: 'Trace id, the beginSeq from log_traces' },
					},
					required: ['projectId', 'source', 'beginSeq'],
					additionalProperties: false,
				},
				execute: async (args) => {
					const stream = streamArg(args);
					const beginSeq = numberArg(args, 'beginSeq', true);
					if (beginSeq === undefined) throw new Error('Pass beginSeq: each trace from log_traces carries one.');
					const client = requireClient(this.client);

					const detail = await logRead(`read trace ${beginSeq}`, 'Take beginSeq from log_traces', () => withEventStream(client, stream, (events) => events.getTrace(beginSeq)));
					return toolText({ ok: true, beginSeq, summary: detail?.summary, events: detail?.events ?? [], context: stream }, "log_read with fromSeq at this trace's beginSeq pages its raw events; narrow with types or maxEvents");
				},
			}),
		];
	}
}
