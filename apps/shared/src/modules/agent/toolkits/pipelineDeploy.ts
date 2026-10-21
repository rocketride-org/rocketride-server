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
// DEPLOY TOOLS — versions, teams, schedules and the switches on a deployment
// =============================================================================

/**
 * The tools the model puts a pipeline in front of a team with. They take the MCP
 * names and argument names (`packages/ai/src/ai/modules/mcp/tools/capability.py`)
 * so the pipeline skills read correctly, and one SDK call each, in the platform's
 * teams-as-environments model: `deploy_add` registers an immutable numbered
 * version of a project, `deploy_to_team` points a team at a version, and
 * schedules, enable, disable and remove act on one team's deployment, addressed
 * by `project_id` and `team_id`.
 *
 * Risk tiers (spec section 6): registering a version and every read are free.
 * Pointing a team at a version, setting a schedule, and enabling, disabling or
 * removing a deployment ask the user first, and so does a `deploy_add` that
 * carries `deploy_to`, since that points a team at the new version too. A "no"
 * goes back to the model as the result, and the client is not called.
 *
 * Every question is asked after the arguments are checked and the client is
 * known to be there, so the user is never asked about a call that cannot run.
 */

import type { PipelineConfig, RocketRideClient } from 'rocketride';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';
import { declined, isJsonObject, messageOf, numberArg, pipelineArg, requireClient, textArg, toolText, type ClientGetter, type ConfirmFn } from './common';

// =============================================================================
// TYPES
// =============================================================================

/** The deploy namespace of the client. */
type DeployApi = RocketRideClient['deploy'];

/** The paging, search, filter and sort a list call takes. */
type ListParams = NonNullable<Parameters<DeployApi['list']>[0]>;

/** One deployment record, as the client returns it. */
type Deployment = Awaited<ReturnType<DeployApi['get']>>;

/** A switch on a team's deployment that asks the user first: enable, disable or remove. */
interface Switch {
	/** The MCP tool name. */
	name: 'deploy_enable' | 'deploy_disable' | 'deploy_remove';
	/** What the action is called in the dialog title and the failure message. */
	verb: 'Enable' | 'Disable' | 'Remove';
	/** What the dialog tells the user will happen, after the question. */
	consequence: string;
	/** What the model reads about the tool. */
	description: string;
	/** The client call. */
	run: (deploy: DeployApi, projectId: string, teamId: string) => Promise<Deployment>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** How to fix each key argument when it is missing (from the MCP tool's own hints). */
const KEY_HINTS = {
	project_id: "Pass the pipeline's project_id, or projectId from a deploy_list row.",
	team_id: "Pass teamId from a deploy_list row, or '@me' for your personal space.",
	source_id: 'Pass the id of a source component in the deployed pipeline.',
	schedule: "Pass a 5-field cron expression, or 'manual' to clear the schedule.",
} as const;

/** How to fix a missing or wrong version. */
const VERSION_ADVICE = 'Pass artifact.version from deploy_add, or a version from deploy_versions.';

/** What paging arguments do when left out. */
const PAGING_ADVICE = 'Omit it to use the server default.';

/** The value that clears a schedule. */
const MANUAL = 'manual';

/** What a cut list result tells the model to do. */
const LIST_CUT_HINT = 'ask for a smaller page_size, or narrow the list with search or filters';

/** The `project_id` and `team_id` properties shared by the tools that address one deployment. */
const DEPLOYMENT_KEY_PROPERTIES = {
	project_id: { type: 'string', description: "Project id: the pipeline's project_id, or projectId on a deploy_list row" },
	team_id: { type: 'string', description: "Team id, the environment (for example Staging or Production): teamId on a deploy_list row, or '@me' for your personal space" },
};

/** The paging properties shared by the list tools. */
const PAGING_PROPERTIES = {
	page: { type: 'integer', minimum: 1, description: '1-based page number (default 1)' },
	page_size: { type: 'integer', minimum: 1, description: 'Rows per page (server default 50, at most 100)' },
};

/** The group's instructions, joined into the system prompt when the group is mounted. */
const INSTRUCTIONS = `## Deploying

- Register a version with deploy_add, point a team at it with deploy_to_team, then run it on a cron with deploy_set_schedule, because registering a version runs nothing.
- Take project_id, team_id and version from the results of deploy_add, deploy_list and deploy_versions, because a guessed id fails.
- The user is asked before you point a team at a version, set a schedule, or enable, disable or remove a deployment, because those change what runs for a team. If they say no, don't retry; ask what they want instead.`;

/** The three switches on a deployment. */
const SWITCHES: Switch[] = [
	{
		name: 'deploy_enable',
		verb: 'Enable',
		consequence: 'Its schedules fire again.',
		description: ["Enable a team's disabled deployment so its schedules fire again. The user is asked first.", '- Pass project_id and team_id from deploy_list or deploy_status.', '- Needs a connected RocketRide engine.'].join('\n'),
		run: (deploy, projectId, teamId) => deploy.enable(projectId, teamId),
	},
	{
		name: 'deploy_disable',
		verb: 'Disable',
		consequence: 'Its schedules stop firing and manual runs are refused until it is enabled again.',
		description: ["Disable a team's deployment, the kill switch: its schedules stop firing and manual runs are refused until deploy_enable. The user is asked first.", '- Use it to stop everything the deployment does at once; to stop one source, clear its schedule with deploy_set_schedule instead.', '- Needs a connected RocketRide engine.'].join('\n'),
		run: (deploy, projectId, teamId) => deploy.disable(projectId, teamId),
	},
	{
		name: 'deploy_remove',
		verb: 'Remove',
		consequence: 'It stops running and leaves the listings; its versions and history are kept.',
		description: ["Remove a team's deployment: it leaves the listings and stops running, but its versions and history are kept. The user is asked first.", '- deploy_to_team revives it.', '- To pause it and keep it listed, use deploy_disable instead.', '- Needs a connected RocketRide engine.'].join('\n'),
		run: (deploy, projectId, teamId) => deploy.remove(projectId, teamId),
	},
];

/** What the model reads about `deploy_set_schedule`: when to use it, when not to, one example. */
const SET_SCHEDULE_DESCRIPTION = `Set or clear the cron schedule of one source on a team's deployment. The user is asked first.

Use it:
- after deploy_to_team, when a deployed pipeline should run by itself at set times;
- with schedule "manual", to stop a source running by itself.

Don't use it:
- to run a pipeline once: use run_pipeline;
- before the team has a deployment: call deploy_to_team first, because there is nothing to schedule until then;
- to stop everything a deployment does: use deploy_disable, which also refuses manual runs.

source_id must be a source component of the deployed version. Schedules fire only while the deployment is enabled. schedule is a 5-field cron expression, a preset such as @hourly or @daily, or "manual" to clear it. ttl is optional: the seconds each run may last, and left out each run lasts until the pipeline finishes.

Example: deploy_set_schedule { "project_id": "p1", "source_id": "webhook_1", "schedule": "0 9 * * 1-5", "team_id": "t1" } runs webhook_1 at 09:00 on weekdays.`;

// =============================================================================
// ARGUMENTS
// =============================================================================

/**
 * A key argument the call must carry.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @returns The trimmed text.
 * @throws When it is missing; the message says how to find the value.
 */
function keyArg(args: Record<string, unknown>, key: keyof typeof KEY_HINTS): string {
	const value = textArg(args, key);
	if (!value) throw new Error(`${key} is required. ${KEY_HINTS[key]}`);
	return value;
}

/**
 * A text argument the call may leave out.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @returns The trimmed text; undefined when it is absent or blank.
 * @throws When it is given but is not text.
 */
function optionalTextArg(args: Record<string, unknown>, key: string): string | undefined {
	const raw = args[key];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string') throw new Error(`${key} must be text.`);
	return raw.trim() || undefined;
}

/**
 * A whole-number argument of 1 or more that the call may leave out.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @param advice - What to do about it, shown when it is wrong.
 * @returns The number; undefined when the argument is absent.
 * @throws When it is not a whole number of 1 or more.
 */
function positiveArg(args: Record<string, unknown>, key: string, advice: string): number | undefined {
	const value = numberArg(args, key, true);
	if (value !== undefined && value < 1) throw new Error(`${key} must be a whole number, 1 or more. ${advice}`);
	return value;
}

/**
 * The registry version a call names.
 *
 * @param args - The tool arguments.
 * @returns The version.
 * @throws When it is missing or is not a whole number of 1 or more.
 */
function versionArg(args: Record<string, unknown>): number {
	const version = positiveArg(args, 'version', VERSION_ADVICE);
	if (version === undefined) throw new Error(`version is required. ${VERSION_ADVICE}`);
	return version;
}

/**
 * The sorters of a list call.
 *
 * @param args - The tool arguments.
 * @returns The sorters, each with a direction (ascending when none was given); undefined when the argument is absent.
 * @throws When `sort` is not a list of `{ field, dir }` objects.
 */
function sortArg(args: Record<string, unknown>): ListParams['sort'] {
	const raw = args.sort;
	if (raw === undefined || raw === null) return undefined;
	const example = 'for example [{"field": "updatedAt", "dir": "desc"}]';
	if (!Array.isArray(raw)) throw new Error(`sort must be a list of sorters, ${example}.`);

	return raw.map((item: unknown) => {
		const field = isJsonObject(item) && typeof item.field === 'string' ? item.field.trim() : '';
		if (!isJsonObject(item) || !field) throw new Error(`Each sorter needs a field, ${example}.`);
		const dir = item.dir ?? 'asc';
		if (dir !== 'asc' && dir !== 'desc') throw new Error('A sorter\'s dir must be "asc" or "desc".');
		return { field, dir };
	});
}

/**
 * The list parameters a call carries: paging, search, filters and sort.
 *
 * @param args - The tool arguments.
 * @returns The parameters; only those the call gave.
 * @throws When one is the wrong kind of value.
 */
function listParams(args: Record<string, unknown>): ListParams {
	const page = positiveArg(args, 'page', PAGING_ADVICE);
	const pageSize = positiveArg(args, 'page_size', PAGING_ADVICE);
	const search = optionalTextArg(args, 'search');
	const filters = args.filters;
	if (filters !== undefined && filters !== null && !isJsonObject(filters)) throw new Error('filters must be an object, for example {"state": "enabled"}.');
	const sort = sortArg(args);

	return {
		...(page !== undefined ? { page } : {}),
		...(pageSize !== undefined ? { pageSize } : {}),
		...(search !== undefined ? { search } : {}),
		...(isJsonObject(filters) ? { filters } : {}),
		...(sort !== undefined ? { sort } : {}),
	};
}

// =============================================================================
// RESULTS
// =============================================================================

/**
 * Unwraps a list envelope the way the MCP tools do: the rows under a name, how
 * many came back, how many match in all, and the page.
 *
 * @param envelope - The client's `{ rows, total, page, pageSize }`.
 * @param rowsKey - What to call the rows.
 * @returns The fields to put in the result; `count` below `total` means more pages.
 */
function pageOf(envelope: { rows?: unknown[]; total?: number; page?: number; pageSize?: number } | undefined, rowsKey: string): Record<string, unknown> {
	const rows = envelope?.rows ?? [];
	return { [rowsKey]: rows, count: rows.length, total: envelope?.total ?? rows.length, page: envelope?.page, pageSize: envelope?.pageSize };
}

/**
 * Runs a client call and rewords a failure so the model knows what to try.
 *
 * @param what - What was being done, for the message ("point team t1 at version 2 of p1").
 * @param advice - How to fix the call, for the message.
 * @param call - The call.
 * @returns What the call returned.
 * @throws With the engine's reason and the advice.
 */
async function engineCall<T>(what: string, advice: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		throw new Error(`Cannot ${what}: ${messageOf(err)}. ${advice}`);
	}
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The deploy toolkit: free reads and new versions, and the actions that ask the user first. */
export class PipelineDeployToolkit extends AgentToolkit {
	readonly name = 'pipeline-deploy';
	readonly instructions = INSTRUCTIONS;

	/** Returns the connected client, or null. */
	private readonly client: ClientGetter;
	/** The workspace view a `path` is read from. */
	private readonly vfs: IWorkspaceFileSystem;
	/** Asks the user before an outward action. */
	private readonly confirm: ConfirmFn;

	/**
	 * Builds the toolkit.
	 *
	 * @param client - The host's client getter.
	 * @param vfs - The workspace view.
	 * @param confirm - Asks the user before a team is pointed at a version, a schedule is set, or a deployment is enabled, disabled or removed.
	 */
	constructor(client: ClientGetter, vfs: IWorkspaceFileSystem, confirm: ConfirmFn) {
		super();
		this.client = client;
		this.vfs = vfs;
		this.confirm = confirm;
	}

	/**
	 * Asks the user, then runs the action only on a yes.
	 *
	 * @param title - What the user is asked to confirm; a no goes back to the model as this.
	 * @param message - The question.
	 * @param act - The action.
	 * @returns The action's result, or the text telling the model the user declined.
	 */
	private async askThen(title: string, message: string, act: () => Promise<string>): Promise<string> {
		if (!(await this.confirm(title, message))) return declined(title);
		return act();
	}

	/**
	 * Registers a pipeline as the next version of its project. Free, unless it also
	 * points a team at the version.
	 *
	 * @param args - The `deploy_add` arguments.
	 * @returns The result text: the artifact, and the deployment when `deploy_to` was given.
	 */
	private async add(args: Record<string, unknown>): Promise<string> {
		const { pipeline } = await pipelineArg(args, this.vfs);
		const name = typeof pipeline.name === 'string' ? pipeline.name.trim() : '';
		const projectId = typeof pipeline.project_id === 'string' ? pipeline.project_id.trim() : '';
		if (!name) throw new Error('The pipeline needs a name: the registry shows it on every deploy surface. Add "name" to the pipeline, then call deploy_add again.');
		if (!projectId) throw new Error('The pipeline needs a project_id: it names the project the version belongs to. Add "project_id" to the pipeline, then call deploy_add again.');
		const comment = optionalTextArg(args, 'comment');
		const deployTo = optionalTextArg(args, 'deploy_to');
		const client = requireClient(this.client);

		const register = async (): Promise<string> => {
			const result = await engineCall('deploy the pipeline', 'A new version may already be registered, so call deploy_versions before you call deploy_add again.', () =>
				client.deploy.add({
					kind: 'pipe',
					pipeline: pipeline as unknown as PipelineConfig & { name: string },
					...(comment !== undefined ? { comment } : {}),
					...(deployTo !== undefined ? { deployTo } : {}),
				})
			);
			return toolText({ ok: true, artifact: result?.artifact, ...(result?.deployment !== undefined ? { deployment: result.deployment } : {}) }, 'deploy_status shows the rest of a deployment');
		};
		// Pointing a team at the new version is the outward part; registering alone is free.
		if (deployTo === undefined) return register();
		return this.askThen(`Deploy ${projectId}`, `Register '${name}' as a new version of ${projectId} and point team ${deployTo} at it?`, register);
	}

	/**
	 * Lists the deployments the user can see.
	 *
	 * @param args - The `deploy_list` arguments.
	 * @returns The result text.
	 */
	private async list(args: Record<string, unknown>): Promise<string> {
		const teamId = optionalTextArg(args, 'team_id');
		const params: ListParams & { teamId?: string } = { ...(teamId !== undefined ? { teamId } : {}), ...listParams(args) };
		const client = requireClient(this.client);

		const envelope = await engineCall('list the deployments', 'Check team_id, or omit it to list every team you can see.', () => client.deploy.list(params));
		return toolText({ ok: true, ...pageOf(envelope, 'deployments') }, LIST_CUT_HINT);
	}

	/**
	 * Reads one team's deployment of a project.
	 *
	 * @param args - The `deploy_status` arguments.
	 * @returns The result text.
	 */
	private async status(args: Record<string, unknown>): Promise<string> {
		const projectId = keyArg(args, 'project_id');
		const teamId = keyArg(args, 'team_id');
		const client = requireClient(this.client);

		const deployment = await engineCall(`read the deployment of ${projectId} for team ${teamId}`, 'deploy_list shows the deployments you can see.', () => client.deploy.get(projectId, teamId));
		return toolText({ ok: true, deployment }, 'deploy_list shows the deployments');
	}

	/**
	 * Lists a project's registered versions.
	 *
	 * @param args - The `deploy_versions` arguments.
	 * @returns The result text.
	 */
	private async versions(args: Record<string, unknown>): Promise<string> {
		const projectId = keyArg(args, 'project_id');
		const params = listParams(args);
		const client = requireClient(this.client);

		const envelope = await engineCall(`list the versions of ${projectId}`, "Use the pipeline's project_id.", () => client.deploy.versions(projectId, params));
		return toolText({ ok: true, project_id: projectId, ...pageOf(envelope, 'versions') }, LIST_CUT_HINT);
	}

	/**
	 * Points a team at a registered version, after the user says yes.
	 *
	 * @param args - The `deploy_to_team` arguments.
	 * @returns The result text.
	 */
	private async toTeam(args: Record<string, unknown>): Promise<string> {
		const projectId = keyArg(args, 'project_id');
		const teamId = keyArg(args, 'team_id');
		const version = versionArg(args);
		const client = requireClient(this.client);

		return this.askThen(`Deploy ${projectId}`, `Point team ${teamId} at version ${version} of ${projectId}?`, async () => {
			const deployment = await engineCall(`point team ${teamId} at version ${version} of ${projectId}`, 'deploy_versions lists the versions to choose from.', () => client.deploy.deploy(projectId, version, teamId));
			return toolText({ ok: true, deployment }, 'deploy_status shows the rest of the deployment');
		});
	}

	/**
	 * Sets or clears the schedule of one source, after the user says yes.
	 *
	 * @param args - The `deploy_set_schedule` arguments.
	 * @returns The result text.
	 */
	private async setSchedule(args: Record<string, unknown>): Promise<string> {
		const projectId = keyArg(args, 'project_id');
		const sourceId = keyArg(args, 'source_id');
		const schedule = keyArg(args, 'schedule');
		const teamId = keyArg(args, 'team_id');
		const ttl = positiveArg(args, 'ttl', 'Omit it to run each task until the pipeline finishes.');
		const client = requireClient(this.client);

		const question = schedule === MANUAL ? `Stop ${sourceId} running on its own for team ${teamId}? Its schedule is cleared.` : `Run ${sourceId} on '${schedule}' for team ${teamId}${ttl !== undefined ? `, each run stopped after ${ttl} seconds` : ''}?`;
		return this.askThen(`Schedule ${projectId}`, question, async () => {
			const deployment = await engineCall(`set the schedule of ${sourceId} for team ${teamId}`, `deploy_status shows the team's deployment, and source_id must be a source in it. The schedule must be '${MANUAL}', a preset like @hourly, or a 5-field cron expression.`, () => client.deploy.setSchedule(projectId, sourceId, schedule, teamId, ttl !== undefined ? { ttl } : {}));
			return toolText({ ok: true, deployment }, 'deploy_status shows the rest of the deployment');
		});
	}

	/**
	 * Enables, disables or removes a team's deployment, after the user says yes.
	 *
	 * @param action - Which switch.
	 * @param args - The tool arguments.
	 * @returns The result text.
	 */
	private async flip(action: Switch, args: Record<string, unknown>): Promise<string> {
		const projectId = keyArg(args, 'project_id');
		const teamId = keyArg(args, 'team_id');
		const client = requireClient(this.client);

		return this.askThen(`${action.verb} ${projectId}`, `${action.verb} the deployment of ${projectId} for team ${teamId}? ${action.consequence}`, async () => {
			const deployment = await engineCall(`${action.verb.toLowerCase()} the deployment of ${projectId} for team ${teamId}`, 'deploy_list shows the deployments you can act on.', () => action.run(client.deploy, projectId, teamId));
			return toolText({ ok: true, deployment }, 'deploy_status shows the rest of the deployment');
		});
	}

	/**
	 * The nine deploy tools.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'deploy_add',
				description: ['Register a pipeline as the next immutable version of its project in the org registry, and return artifact.version.', '- Pass exactly one of path (a .pipe file in the workspace) or pipeline (the pipeline object); it needs a name and a project_id.', '- Registering runs nothing: call deploy_to_team, or pass deploy_to, to put the version live on a team.', '- deploy_to points that team at the new version too, so the user is asked first, and a no registers nothing. Without deploy_to the user is not asked.', '- Each call adds a version: if one fails or times out, call deploy_versions before you try again.', '- Needs a connected RocketRide engine.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Workspace path of a .pipe file, for example pipelines/digest.pipe' },
						pipeline: { type: 'object', description: 'The pipeline object, flat or wrapped as in a .pipe file; it must carry name and project_id' },
						comment: { type: 'string', description: 'Optional "what changed" note kept with the version' },
						deploy_to: { type: 'string', description: "Optional team id to point at the new version in the same call (same as deploy_to_team; '@me' for your personal space)" },
					},
					additionalProperties: false,
				},
				execute: (args) => this.add(args),
			}),
			new AgentTool({
				name: 'deploy_list',
				description: ['List the team deployments you can see, one row per project and team, with its version, state and per-source schedules.', "- Pass team_id ('@me' for your personal space) to see one team; omit it to see every deployment you can see.", '- Paged: count is the rows returned and total is every match; pass page to read on.', '- search matches the project id, pipeline name and team id; filters takes column filters such as {"state": "enabled"}.', '- Needs a connected RocketRide engine.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						team_id: { type: 'string', description: "Only this team's deployments ('@me' for your personal space); omit for every deployment you can see" },
						...PAGING_PROPERTIES,
						search: { type: 'string', description: 'Free text matched against projectId, pipelineName and teamId' },
						filters: { type: 'object', description: 'Column filters, for example {"state": "enabled"}' },
						sort: {
							type: 'array',
							description: 'Sorters, for example [{"field": "updatedAt", "dir": "desc"}] (default updatedAt, newest first)',
							items: { type: 'object', properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['field'] },
						},
					},
					additionalProperties: false,
				},
				execute: (args) => this.list(args),
			}),
			new AgentTool({
				name: 'deploy_status',
				description: ["Get one team's deployment of a project: its version, state, per-source schedules, and who deployed it and when.", '- A team with no deployment of the project fails; deploy_list shows the ones that exist.', '- Needs a connected RocketRide engine.'].join('\n'),
				parameters: { type: 'object', properties: DEPLOYMENT_KEY_PROPERTIES, required: ['project_id', 'team_id'], additionalProperties: false },
				execute: (args) => this.status(args),
			}),
			new AgentTool({
				name: 'deploy_versions',
				description: ["List a project's registered versions, newest first: version, pipelineName, comment and publishedAt.", '- These are the versions deploy_to_team can point a team at.', '- Paged: count is the rows returned and total is every match; pass page to read on.', '- Needs a connected RocketRide engine.'].join('\n'),
				parameters: { type: 'object', properties: { project_id: DEPLOYMENT_KEY_PROPERTIES.project_id, ...PAGING_PROPERTIES }, required: ['project_id'], additionalProperties: false },
				execute: (args) => this.versions(args),
			}),
			new AgentTool({
				name: 'deploy_to_team',
				description: ['Point a team (the environment) at a registered version of a project. The user is asked first.', '- It covers a first deploy, a promotion (the same version to another team) and a rollback (an older version).', '- Take version from deploy_add (artifact.version) or deploy_versions.', '- A removed deployment is revived.', '- Needs a connected RocketRide engine.'].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						project_id: DEPLOYMENT_KEY_PROPERTIES.project_id,
						version: { type: 'integer', minimum: 1, description: "Registry version: artifact.version from deploy_add, or a row's version from deploy_versions" },
						team_id: DEPLOYMENT_KEY_PROPERTIES.team_id,
					},
					required: ['project_id', 'version', 'team_id'],
					additionalProperties: false,
				},
				execute: (args) => this.toTeam(args),
			}),
			new AgentTool({
				name: 'deploy_set_schedule',
				description: SET_SCHEDULE_DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						project_id: DEPLOYMENT_KEY_PROPERTIES.project_id,
						source_id: { type: 'string', description: 'Id of the source component the schedule fires; it must exist in the deployed version' },
						schedule: { type: 'string', description: "5-field cron expression, a preset such as @hourly, or 'manual' to clear the schedule" },
						team_id: DEPLOYMENT_KEY_PROPERTIES.team_id,
						ttl: { type: 'integer', minimum: 1, description: 'Optional run window in seconds; omit to run each task until the pipeline finishes' },
					},
					required: ['project_id', 'source_id', 'schedule', 'team_id'],
					additionalProperties: false,
				},
				execute: (args) => this.setSchedule(args),
			}),
			...SWITCHES.map(
				(action) =>
					new AgentTool({
						name: action.name,
						description: action.description,
						parameters: { type: 'object', properties: DEPLOYMENT_KEY_PROPERTIES, required: ['project_id', 'team_id'], additionalProperties: false },
						execute: (args) => this.flip(action, args),
					})
			),
		];
	}
}
