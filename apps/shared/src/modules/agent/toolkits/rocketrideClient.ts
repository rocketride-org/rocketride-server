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
// ROCKETRIDE CLIENT TOOL — rocketride_client calls any client method by the guide's name
// =============================================================================

/**
 * One tool reaches RocketRide: `rocketride_client` takes a client method as
 * `ROCKETRIDE_typescript_API.md` names it (`validate`, `use`, `deploy.add`,
 * `log.read`) and its arguments in order, calls it on the connected client and
 * returns the result as JSON. The guide is the manual, so nothing here repeats it.
 *
 * - The tool prepares each call: it checks the name, reads the arguments and
 *   names the exact call as its act, so the approval list (`approval.ts`)
 *   rates it before the client is touched. That list blocks the methods that
 *   hand the model a credential, the raw `call` and `request`, and the `fs*`
 *   store methods, and asks the user first for outward ones. Methods that
 *   need a callback, bytes or a live object are refused here. Each refusal
 *   says what to call instead.
 * - For `use`, `validate` and `deploy.add`, `{ "filepath": "pipelines/x.pipe" }`
 *   is read from the run's workspace view, unsaved edits included, and passed as
 *   `pipeline`, the way the guide's `filepath` works locally.
 * - Results go through `toolText`, which strips secrets and clips. Two
 *   exceptions: `getService` and `getServices` are static schemas and are not
 *   redacted, and the run token at the top of a `use` or `deploy.run` result
 *   stays readable so the model can follow its run. `getServices` drops its
 *   SVG icon table, and when it still does not fit, each service is cut to its
 *   category and a one-line summary.
 * - A `use` that started a run, and a restart, are reported to the run
 *   ledger (`runs.ts`), which records the runs this conversation owns.
 * - A `use` refused with "Pipeline is already running" gets RERUN_GUIDANCE.
 */

import type { RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit, type ToolStep } from '../tools';
import { clip, isJsonObject, isWalkable, messageOf, pipelineArg, redactSecrets, requireClient, RESULT_MAX_CHARS, toolText, type ClientGetter, type JsonObject } from './common';
import type { RunLedger } from './runs';

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
 * @param raw - The call's `method` argument.
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
 * @param client - The connected client.
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
 * @param method - The checked method name.
 * @param params - The method's arguments.
 * @param vfs - The run's workspace view.
 * @returns The arguments to call the method with.
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
 * @param value - Any value.
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
 * The engine's catalog made fit to read. The SVG icon table alone is far over
 * the result limit, so it goes. When the rest still does not fit, which is the
 * usual case, each service is cut to one line: its category and a summary. One
 * line each keeps the whole list well inside the limit, so no service drops
 * off the end.
 *
 * @param result - What `getServices()` returned.
 * @returns The catalog without icons, or the trimmed catalog.
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
 * @param method - The checked method name.
 * @param result - What the method returned.
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
	 * @param client - The host's client getter.
	 * @param vfs - The workspace view.
	 * @param hide - Hides the values the run's file tools hid, before a result is cut.
	 * @param runs - The run ledger, when the run keeps one.
	 */
	constructor(client: ClientGetter, vfs: IWorkspaceFileSystem, hide = (text: string): string => text, runs?: Pick<RunLedger, 'afterCall'>) {
		super();
		this.client = client;
		this.vfs = vfs;
		this.hide = hide;
		this.runs = runs;
	}

	/**
	 * The one client tool.
	 *
	 * @returns The group's tools.
	 */
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
	 * Gets a call ready: checks the name, reads the arguments, and names the
	 * exact call as the act, so the approval list rates it before the client
	 * is touched. The run makes the call and shapes its result.
	 *
	 * @param args - The tool arguments: `method`, and `params` when the method takes any.
	 * @returns The step: the method and its final arguments, and the run that calls it.
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
