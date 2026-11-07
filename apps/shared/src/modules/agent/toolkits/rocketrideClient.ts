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
// ROCKETRIDE CLIENT TOOL — rocketride_client, which calls any client method by the guide's name, and the runs it started
// =============================================================================

/**
 * `rocketride_client` calls one client method by the name `ROCKETRIDE_typescript_API.md` gives it, with
 * its arguments in order, and returns the result as JSON; the guide is the manual.
 * - Each call is prepared first and named as its act, so the approval list (`approval.ts`) rates it
 *   before the client is touched. Methods that need a callback, bytes or a live object are refused.
 * - `{ "filepath": ... }` for `use`, `validate` and `deploy.add` is read from the run's workspace view,
 *   unsaved edits included, and passed as `pipeline`.
 * - Results go through `toolText`, except `getService(s)` (static schemas, not redacted) and the run
 *   token of a `use` or `deploy.run` result, which stays readable.
 */

import type { RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit, type ToolStep } from '../tools';
import type { RunRecord } from '../turn';
import { clip, isJsonObject, isWalkable, messageOf, pipelineArg, redactSecrets, requireClient, RESULT_MAX_CHARS, toolText, type ClientGetter, type JsonObject } from './common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The methods that cannot work over JSON, each with the JSON way to do the job. */
const NOT_JSON: Record<string, string> = {
	pipe: 'it returns a live data pipe; send text with send(token, text)',
	sendFiles: 'it needs browser File objects; send text with send(token, text)',
	chat: 'it needs a Question instance; send the question as text with send(token, text)',
	addMonitor: 'it delivers events to a callback nothing reads; poll getTaskStatus(token) instead',
	'log.openEventStream': 'it returns a live stream; read the log with log.read or log.segment',
	'database.drizzle': 'it needs a constructor; run SQL with database.query',
	'database.sequelize': 'it needs a constructor; run SQL with database.query',
};

/** The client's sub-clients: the only names that hold methods of their own. */
const SUB_CLIENTS = new Set(['account', 'billing', 'database', 'deploy', 'log']);

/** The methods whose first argument may name a workspace pipeline by `filepath`. */
const PIPELINE_METHODS = new Set(['use', 'validate', 'deploy.add']);

/** The methods whose top-level `token` is the run token, kept readable. */
const RUN_TOKEN_METHODS = new Set(['use', 'deploy.run']);

/** The engine's refusal of a second run of a pipeline that is still running. */
const ALREADY_RUNNING = /already running/i;

/** How to run an edited pipeline whose earlier run still holds it (the engine never applies a new pipeline to a running task). */
const RERUN_GUIDANCE = 'Your edits are not in the running task. To run them, terminate that run (getTaskToken({ "projectId": ..., "source": ... }) gives its token) and call use again; if this conversation did not start it, ask the user first.';

/** The longest a service's summary runs in a trimmed catalog, in characters. */
const SUMMARY_MAX_CHARS = 100;

/** The guide that documents every client method. */
const GUIDE = '.rocketride/docs/ROCKETRIDE_typescript_API.md';

/** What a cut result tells the model to do. */
const RESULT_HINT = 'ask for less, such as one item or a smaller page';

/** What a cut catalog tells the model to do. */
const CATALOG_HINT = 'getService(name) gives one service in full';

/** What a cut service schema tells the model. */
const SERVICE_HINT = 'the rest of this service is not available; validate reports what a config is missing';

/** What the model reads about the RocketRide client, joined into the prompt with the toolkit. */
const INSTRUCTIONS = `## RocketRide client

- Call any RocketRide client method with rocketride_client, named as .rocketride/docs/ROCKETRIDE_typescript_API.md names it, with its arguments in order in params, because that guide documents every method.
- Skip the guide's install, environment and connect steps, because the client is already connected and signed in as the user.
- Pass a workspace pipeline as {"filepath": "pipelines/<name>.pipe"}, because the tool reads it from the workspace, unsaved edits included.
- Make file changes with the file tools, because they keep the editor in step and validate every .pipe save.`;

/** What the model reads about `rocketride_client`: what to pass, what is refused, one example. */
const DESCRIPTION = `Call one RocketRide client method and return its result as JSON.

- method: the method as ROCKETRIDE_typescript_API.md names it, for example "validate", "use", "getTaskStatus", "deploy.add" or "log.read".
- params: its arguments in order; leave it out when there are none.
- For use, validate and deploy.add, pass a workspace pipeline as {"filepath": "pipelines/<name>.pipe"}.
- Methods that hand out credentials, the raw call and request, and the fs* store methods are refused; the error says what to use instead.
- Secret values in results show as [redacted], and long results are cut.

Example: rocketride_client { "method": "use", "params": [{ "filepath": "pipelines/chat.pipe" }] } starts the pipeline and returns its token.`;

// =============================================================================
// METHOD NAMES
// =============================================================================

/**
 * The method a call names, checked before the client is touched.
 *
 * @returns The method as the tool calls it: trimmed, with one leading `client.` dropped.
 * @throws When the name is empty, private, not a method's shape, or cannot work over JSON; the message says what to call instead.
 */
function methodName(raw: unknown): string {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) throw new Error(`Pass method: a client method as ${GUIDE} names it, such as "validate" or "deploy.add".`);

	const name = text.startsWith('client.') ? text.slice('client.'.length) : text;
	const segments = name.split('.');
	if (segments.some((segment) => segment.startsWith('_'))) throw new Error(`'${name}' is private to the client. Use a method from ${GUIDE}.`);
	if (segments.length > 2 || segments.includes('') || (segments.length === 2 && !SUB_CLIENTS.has(segments[0]))) {
		throw new Error(`'${name}' is not a RocketRide client method: only account, billing, database, deploy and log hold methods of their own, as in "deploy.add".`);
	}

	if (Object.hasOwn(NOT_JSON, name)) throw new Error(`${name} can't work over JSON: ${NOT_JSON[name]}.`);
	return name;
}

/**
 * Finds the function a checked name points at, and the object it must be called on.
 *
 * @param method - A name `methodName` passed.
 * @returns The object that holds the method (the client or a sub-client) and the method.
 * @throws When the name does not resolve to a client method.
 */
function resolveMethod(client: RocketRideClient, method: string): { owner: object; fn: (...params: unknown[]) => unknown } {
	const segments = method.split('.');
	const last = segments[segments.length - 1];
	const owner = segments.length === 2 ? (client as unknown as Record<string, unknown>)[segments[0]] : client;
	const fn = typeof owner === 'object' && owner !== null && !(last in Object.prototype) ? (owner as Record<string, unknown>)[last] : undefined;
	if (typeof owner !== 'object' || owner === null || typeof fn !== 'function') {
		throw new Error(`'${method}' is not a RocketRide client method. Use a name from ${GUIDE}, such as "validate", "use" or "deploy.add".`);
	}
	return { owner, fn: fn as (...params: unknown[]) => unknown };
}

// =============================================================================
// ARGUMENTS
// =============================================================================

/**
 * The method's arguments, in order.
 *
 * @param raw - The call's `params` argument.
 * @returns The arguments; empty when none were given.
 * @throws When `params` is not an array: wrapping it would hand its fields to the wrong arguments.
 */
function paramsOf(raw: unknown): unknown[] {
	if (raw === undefined || raw === null) return [];
	if (Array.isArray(raw)) return raw;
	throw new Error(`params must be an array of the method's arguments in order, such as [{"filepath": "pipelines/chat.pipe"}] for use, or ["<projectId>", "<teamId>"] for deploy.get.`);
}

/**
 * Reads a workspace pipeline named by `filepath` and passes it as `pipeline`,
 * so the user's unsaved edits are what runs. For `deploy.add`, a pipe without
 * a name or project id is refused here, before the registry sees it.
 *
 * @throws When the file cannot be read, or `deploy.add`'s pipeline has no name or project id; the message says how to fix it.
 */
async function withPipelineFile(method: string, params: unknown[], vfs: IWorkspaceFileSystem): Promise<unknown[]> {
	if (!PIPELINE_METHODS.has(method) || !isJsonObject(params[0])) return params;

	let options: JsonObject = params[0];
	const { filepath, ...rest } = options;
	if (typeof filepath === 'string' && (options.pipeline === undefined || options.pipeline === null)) {
		const { pipeline } = await pipelineArg({ path: filepath }, vfs);
		options = { ...rest, pipeline };
	}

	if (method === 'deploy.add' && isJsonObject(options.pipeline) && (options.kind === undefined || options.kind === 'pipe')) {
		const { pipeline } = options;
		const name = typeof pipeline.name === 'string' ? pipeline.name.trim() : '';
		const projectId = typeof pipeline.project_id === 'string' ? pipeline.project_id.trim() : '';
		if (!name) throw new Error('The pipeline needs a name: the registry shows it on every deploy surface. Add "name" to the pipeline, then call deploy.add again.');
		if (!projectId) throw new Error('The pipeline needs a project_id: it names the project the version belongs to. Add "project_id" to the pipeline, then call deploy.add again.');
	}
	return options === params[0] ? params : [options, ...params.slice(1)];
}

// =============================================================================
// RESULTS
// =============================================================================

/**
 * Whether a value is plain data that prints as JSON: no functions, no class
 * instances. A class instance such as a data pipe holds the client, and
 * printing it would print the client's key.
 *
 * @returns True for primitives, null, undefined, and arrays and plain objects of those.
 */
function isPlainData(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
	return isWalkable(value) && Object.values(value).every(isPlainData);
}

/**
 * The first sentence of a service's description, on one line and cut short.
 *
 * @param description - The service's `description`, text or lines of text.
 * @returns The summary; empty when there is no description.
 */
function summaryOf(description: unknown): string {
	const joined = Array.isArray(description) ? description.join(' ') : description;
	const text = typeof joined === 'string' ? joined.replace(/\s+/g, ' ').trim() : '';
	const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : sentence;
}

/**
 * A service cut to one line, the way the catalog lists it when trimmed.
 *
 * @param service - One entry of the catalog's `services`.
 * @returns Its `classType` tags and summary, for example `[llm] Calls OpenAI.`; empty when it has neither.
 */
function serviceLine(service: JsonObject): string {
	const tags = Array.isArray(service.classType) ? service.classType.filter((tag): tag is string => typeof tag === 'string') : [];
	return [tags.length > 0 ? `[${tags.join(', ')}]` : '', summaryOf(service.description)].filter((part) => part !== '').join(' ');
}

/**
 * The engine's catalog made fit to read: the SVG icon table goes (it alone is far over the result
 * limit), and when the rest still does not fit, each service is cut to its category and summary so
 * no service drops off the end.
 */
function catalogOf(result: unknown): unknown {
	if (!isJsonObject(result)) return result;
	const { icons: _icons, ...catalog } = result;
	if (JSON.stringify(catalog, null, 1).length <= RESULT_MAX_CHARS) return catalog;

	const services = Object.entries(isJsonObject(catalog.services) ? catalog.services : {})
		.filter((entry): entry is [string, JsonObject] => isJsonObject(entry[1]))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, service]) => [name, serviceLine(service)]);
	return { note: 'Each service is cut to its classType tags and a one-line summary to fit; getService(name) gives one service in full.', version: catalog.version, services: Object.fromEntries(services) };
}

/**
 * Turns a method's result into the text the tool returns.
 *
 * @param hide - Hides the values the run's file tools hid, before the cut.
 * @returns The result as JSON, secrets stripped and clipped, with the exceptions in the module comment.
 * @throws When the result is a live object, which cannot be shown as JSON.
 */
function resultText(method: string, result: unknown, hide: (text: string) => string): string {
	if (result === undefined) return `${method} finished with no result.`;
	if (!isPlainData(result)) throw new Error(`${method} returned a live object, which can't be shown as JSON. Call a method that returns data; ${GUIDE} lists them.`);

	// Static node metadata with no user data in it, so it is not redacted: redaction
	// would also hide the type and title of every field whose name looks secret.
	if (method === 'getServices') return clip(JSON.stringify(catalogOf(result), null, 1), CATALOG_HINT);
	if (method === 'getService') return clip(JSON.stringify(result, null, 1), SERVICE_HINT);

	if (RUN_TOKEN_METHODS.has(method) && isJsonObject(result) && typeof result.token === 'string') {
		const { token, ...rest } = result;
		return clip(hide(JSON.stringify({ token, ...redactSecrets(rest) }, null, 1)), RESULT_HINT);
	}
	return toolText(result, RESULT_HINT, hide);
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The RocketRide client toolkit: one tool, `rocketride_client`, that calls any client method by the guide's name. */
export class RocketRideClientToolkit extends AgentToolkit {
	readonly name = 'rocketride-client';
	readonly instructions = INSTRUCTIONS;

	/** Returns the connected client, or null. */
	private readonly client: ClientGetter;
	/** The workspace view a `filepath` is read from. */
	private readonly vfs: IWorkspaceFileSystem;
	/** Hides the values the run's file tools hid. */
	private readonly hide: (text: string) => string;
	/** Hears each call that worked, to record the runs this conversation starts. */
	private readonly runs?: Pick<RunLedger, 'afterCall'>;

	/**
	 * Builds the toolkit.
	 *
	 * @param runs - The run ledger, when the run keeps one.
	 */
	constructor(client: ClientGetter, vfs: IWorkspaceFileSystem, hide = (text: string): string => text, runs?: Pick<RunLedger, 'afterCall'>) {
		super();
		this.client = client;
		this.vfs = vfs;
		this.hide = hide;
		this.runs = runs;
	}

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'rocketride_client',
				description: DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						method: { type: 'string', description: 'The client method as ROCKETRIDE_typescript_API.md names it, for example validate, use or deploy.add' },
						params: { type: 'array', items: {}, description: "The method's arguments in order; defaults to []" },
					},
					required: ['method'],
					additionalProperties: false,
				},
				prepare: (args) => this.prepareCall(args),
			}),
		];
	}

	/**
	 * Gets a call ready and names the exact call as the act, so the approval list rates it before the
	 * client is touched; the run makes the call.
	 * @param args - `method`, and `params` when the method takes any.
	 * @throws When the call can't be made; the message says how to fix it.
	 */
	private async prepareCall(args: Record<string, unknown>): Promise<ToolStep> {
		const method = methodName(args.method);
		const given = paramsOf(args.params);
		const { owner, fn } = resolveMethod(requireClient(this.client), method);
		const params = await withPipelineFile(method, given, this.vfs);
		return {
			act: { name: method, params },
			run: async () => {
				let result: unknown;
				try {
					result = await fn.apply(owner, params);
				} catch (err) {
					const reason = messageOf(err);
					throw new Error(`${method} failed: ${reason}.${method === 'use' && ALREADY_RUNNING.test(reason) ? ` ${RERUN_GUIDANCE}` : ''}`);
				}
				await this.runs?.afterCall(method, params, result);
				return resultText(method, result, this.hide);
			},
		};
	}
}

// =============================================================================
// RUNS — the pipeline runs this conversation started, and whether a run is one
// =============================================================================

/**
 * Says which runs this conversation started, so terminate and restart act on them without asking in
 * Auto mode (approval.ts).
 * - A `use` the engine answers with `reused: false` started a run; its status is read at once and
 *   recorded (token, project_id, source, startTime, scope, conversation). A `deploy.run` is never
 *   recorded: a token and a later start time don't prove who started it.
 * - Right before an Auto terminate or restart, `recheck` reads the status again; start time,
 *   project_id, source and scope must match, since the engine reuses a token for a project and source.
 * Records live in the session file, so a reloaded conversation still owns its runs. The run can still
 * change between the recheck and the call; that window is a known limit.
 */

// =============================================================================
// TYPES
// =============================================================================

/** The run a terminate or restart call names: its token, or for restart, its project and source (and a team for a team's deployed run). */
export interface RunTarget {
	token?: string;
	projectId?: string;
	source?: string;
	teamId?: string;
}

/** What the approvals ask about runs. */
export interface RunOwnership {
	/**
	 * The record of the run a call targets, when this conversation started it.
	 *
	 * @returns The record, or undefined for a run started elsewhere or not verified.
	 */
	owned(target: RunTarget): RunRecord | undefined;
	/**
	 * Reads the run's status again, right before an Auto terminate or restart.
	 *
	 * @param record - The record approve() found.
	 * @returns null when the run is still the one recorded, else why not.
	 */
	recheck(record: RunRecord): Promise<string | null>;
}

/** What the ledger needs from its run. */
export interface RunLedgerOptions {
	/** The real client, for status reads. */
	client: ClientGetter;
	/** The scope the run started in ('' for the user's own files). */
	scopeKey: string;
	/** The host's scope now: a team switch changes it. */
	currentScope: () => string;
	/** The conversation (session id). */
	conversationId: string;
}

// =============================================================================
// THE LEDGER
// =============================================================================

/** One run's view of the conversation's runs. */
export class RunLedger implements RunOwnership {
	/** The records this run added, in order. */
	readonly started: RunRecord[] = [];

	/**
	 * @param records - The conversation's records; the ledger adds to and refreshes this array in place.
	 * @param o - The client, the scopes and the conversation.
	 */
	constructor(
		readonly records: RunRecord[],
		private readonly o: RunLedgerOptions
	) {}

	owned(target: RunTarget): RunRecord | undefined {
		// a team's deployed run is never one this conversation started with use
		if (target.teamId) return undefined;
		if (target.token) return this.records.find((r) => r.token === target.token);
		if (target.projectId && target.source) return this.records.find((r) => r.projectId === target.projectId && r.source === target.source);
		return undefined;
	}

	async recheck(record: RunRecord): Promise<string | null> {
		if (this.o.currentScope() !== record.scopeKey) return 'the workspace switched to another team since it started';
		let status: Awaited<ReturnType<RocketRideClient['getTaskStatus']>>;
		try {
			status = await this.status(record.token);
		} catch (err) {
			return `its status could not be read (${messageOf(err)})`;
		}
		if (status.startTime !== record.startTime) return 'a different run holds its token now';
		if (status.project_id !== record.projectId || status.source !== record.source) return 'its project or source changed';
		return null;
	}

	/**
	 * Hears a rocketride_client call that worked: a fresh `use` is recorded,
	 * and a restart refreshes the record of the run it named.
	 */
	async afterCall(method: string, params: readonly unknown[], result: unknown): Promise<void> {
		if (method === 'use') await this.recordUse(result);
		else if (method === 'restart' && isJsonObject(params[0])) {
			const o = params[0];
			const record = this.owned({ token: text(o.token), projectId: text(o.projectId), source: text(o.source), teamId: text(o.teamId) });
			if (record) await this.refresh(record);
		}
	}

	/** Records a run that `use` started fresh, from a status read. */
	private async recordUse(result: unknown): Promise<void> {
		if (!isJsonObject(result) || result.reused !== false || typeof result.token !== 'string') return;
		const { token } = result;
		try {
			const status = await this.status(token);
			const record: RunRecord = { token, projectId: status.project_id, source: status.source, startTime: status.startTime, scopeKey: this.o.scopeKey, conversationId: this.o.conversationId };
			// a token the engine reused for a new run replaces its old record
			const at = this.records.findIndex((r) => r.token === token);
			if (at >= 0) this.records.splice(at, 1);
			this.records.push(record);
			this.started.push(record);
		} catch (err) {
			console.log(`[agent] run ${token.slice(0, 11)}… started, but its status could not be read, so it is not recorded as this conversation's: ${messageOf(err)}`);
		}
	}

	/** Refreshes a record after a restart; one whose status cannot be read stays as it was, and its recheck then fails. */
	private async refresh(record: RunRecord): Promise<void> {
		try {
			const status = await this.status(record.token);
			Object.assign(record, { projectId: status.project_id, source: status.source, startTime: status.startTime });
		} catch (err) {
			console.log(`[agent] run ${record.token.slice(0, 11)}… restarted, but its status could not be read: ${messageOf(err)}`);
		}
	}

	/** The run's status, from the real client. */
	private status(token: string): ReturnType<RocketRideClient['getTaskStatus']> {
		const client = this.o.client();
		if (!client) return Promise.reject(new Error('not connected'));
		return client.getTaskStatus(token);
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}
