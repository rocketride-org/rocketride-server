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
// APP TOOLS — create an app, deploy a version, publish it
// =============================================================================

/**
 * The tools that take an app from nothing to live: `create_app` scaffolds an app through the host,
 * `deploy_app` packs and uploads it as the next version and waits for the server build (an upload
 * that fails to build serves nothing), and `publish_app` puts a built version in front of you, a team,
 * or everyone. Creating and deploying are free; `publish_app` names the one client call it will make
 * (`publishApp` or `submitApp`) and the approval list decides whether the user is asked. A @public
 * binding serves only a `ready` version: submitted, then approved by an admin.
 */

import type { RocketRideClient } from 'rocketride';

import type { AgentHost } from '../host';
import { AgentTool, AgentToolkit, type ToolStep } from '../tools';
import { messageOf, numberArg, redactText, requireClient, sleep, textArg, type ClientGetter } from './common';
import { findApp, readApps, type AppEntry } from './inventory';

// =============================================================================
// TYPES
// =============================================================================

/** One version on an app's rail, as the client returns it. */
type Version = Awaited<ReturnType<RocketRideClient['listDeployments']>>[number];

type BuildState = 'ok' | 'failed' | 'running';

/** An app that has the id deploy and publish need. */
type IdentifiedApp = AppEntry & { id: string };

/** The audiences `publish_app` takes. */
type Target = 'me' | 'team' | 'public';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Same rule as `APP_NAME_RE` in `apps/shared/src/tools/appdev/NewAppForm.tsx`. */
const APP_NAME_RE = /^[a-z][a-zA-Z0-9_-]*$/;

/** The templates the scaffold offers. */
const TEMPLATES = ['Blank', 'Dashboard'] as const;

const TARGETS: readonly Target[] = ['me', 'team', 'public'];

/** How much of a failed build's log the model reads: the end, where the error is. */
const BUILD_LOG_TAIL_CHARS = 8_000;

/** The loop's time limit for a `deploy_app` call (run.ts): packing, uploading and building an app outlasts the default. */
export const DEPLOY_APP_TIMEOUT_MS = 600_000;

/** How long `deploy_app` waits for the server build, unless the host says otherwise. It ends inside DEPLOY_APP_TIMEOUT_MS, so the model hears where the build got to. */
const DEFAULT_BUILD_WAIT_MS = 540_000;

/** How often `deploy_app` asks for the build's progress, unless the host says otherwise. */
const DEFAULT_POLL_MS = 3_000;

/** The reply when the organization has no developer name, so it can deploy nothing (`packages/ai/src/ai/account/app_deploy.py:283-286`). */
const NO_DEVELOPER_MESSAGE = "Deploy refused: this organization hasn't claimed a developer name yet. An org admin must claim it before apps can be deployed; tell the user, because you can't do this.";

/** The group's instructions, joined into the system prompt when the group is mounted. */
const INSTRUCTIONS = `## Apps

- The app's preview rebuilds from your saves, and the user may be watching it.
- Make a new app with create_app, not by writing its files, because the scaffold sets up the manifest and the build.
- Deploy with deploy_app after check_app passes, because the server builds the app again and a broken build serves nothing.
- Publish only when the user asks you to, because it puts the app in front of other people. publish_app asks the user first; if they say no, don't retry, ask what they want instead.
- If deploy_app says the organization has no developer name, tell the user an org admin must claim one, because you can't.`;

/** What the model reads about `deploy_app`: when to use it, when not to, one example. */
const DEPLOY_DESCRIPTION = `Upload the app as its next version and wait for the server build, then say whether the build is OK or return its errors.

Use it:
- when the app works and the user wants it shipped, after check_app passes;
- to put a fix in front of the server build, which type-checks the app again.

Don't use it:
- to preview a change: the open app already rebuilds when you save;
- to put the version in front of people: use publish_app once the build is OK;
- again after it reports a build failure, until you've fixed the source, because each call adds a version.

Deploying is free and the user isn't asked. It refuses when the app has uncommitted changes (the user commits them first) and when the organization hasn't claimed a developer name (an org admin does that).

Example: deploy_app { "app": "daybook-ui", "message": "Add the search box" } returns "Deployed v4; server build OK."`;

/** What the model reads about `publish_app`: when to use it, when not to, one example. */
const PUBLISH_DESCRIPTION = `Put a deployed version of an app in front of people. The user is asked first.

Use it:
- when the user asks for the app to be available to themselves, to a team, or to everyone;
- target "me" for the user alone, "team" with team set to a team's name or id, and "public" for everyone.

Don't use it:
- before deploy_app: there must be a version whose server build is OK;
- on your own initiative: publishing is the user's call;
- to retry after the user said no.

Public goes through review: a private version is submitted for review and goes public only after an admin approves it; call again once it's approved to publish it. version defaults to the newest version whose build is OK.

Example: publish_app { "app": "daybook-ui", "target": "team", "team": "Staging" } publishes the newest built version to the Staging team.`;

// =============================================================================
// ARGUMENTS
// =============================================================================

/**
 * The app a call names, with its manifest id; `verb` names the action in errors ("deployed").
 * @throws When `app` is missing, matches no app, or the app has no manifest id.
 */
async function appArg(host: AgentHost, args: Record<string, unknown>, verb: string): Promise<IdentifiedApp> {
	const ref = textArg(args, 'app');
	if (!ref) throw new Error("app is required. Pass an app's folder name, id or name; list_workspace shows them.");
	const app = findApp(await readApps(host.vfs, (id) => host.devSession(id) !== null), ref);
	if (!app.id) {
		const why = app.error ? ` (${app.error})` : '';
		throw new Error(`${app.folder} has no manifest id${why}, so it can't be ${verb}. Add appManifest.id to ${app.path}/package.json, then call the tool again.`);
	}
	return { ...app, id: app.id };
}

function audienceWords(target: Target, team: string): string {
	if (target === 'me') return 'you';
	return target === 'team' ? `team ${team}` : 'everyone';
}

// =============================================================================
// BUILDS AND VERSIONS
// =============================================================================

/**
 * How a build stands, read as the dashboard reads it: an empty status (older versions carry none)
 * or `ok` is OK, `failed` failed, and any other word is a step still going.
 */
function buildStateOf(version: Version): BuildState {
	const word = version.buildStatus ?? '';
	if (word === '' || word === 'ok') return 'ok';
	return word === 'failed' ? 'failed' : 'running';
}

/** A sorted copy, newest first (the server sends it that way; this does not rely on it). */
function newestFirst(rail: Version[]): Version[] {
	return [...rail].sort((a, b) => b.registryVersion - a.registryVersion);
}

/**
 * The version number in the server's reply to an app upload (`{ artifact: <rail entry> }`). The client
 * types the artifact as a pipeline's, which has no `registryVersion`, so it is read untyped.
 */
function uploadedVersion(reply: unknown): number | undefined {
	if (typeof reply !== 'object' || reply === null) return undefined;
	const artifact = (reply as { artifact?: unknown }).artifact;
	if (typeof artifact !== 'object' || artifact === null) return undefined;
	const version = (artifact as { registryVersion?: unknown }).registryVersion;
	return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : undefined;
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The app toolkit: create and deploy are free, and publishing names its call for the approval list. */
export class AppToolkit extends AgentToolkit {
	readonly name = 'apps';
	readonly instructions = INSTRUCTIONS;

	/** Returns the connected client, or null. */
	private readonly client: ClientGetter;
	/** The host: the workspace, the scaffold, the packer and the dev sessions. */
	private readonly host: AgentHost;
	/** How often to ask for the build's progress. */
	private readonly pollMs: number;
	/** How long to wait for the build. */
	private readonly buildWaitMs: number;
	/** Aborted when the user stops the run; the build wait ends. */
	private readonly signal?: AbortSignal;
	/** Hides the values the run's file tools hid. */
	private readonly hide: (text: string) => string;
	/** Hears each file a scaffold wrote. */
	private readonly created?: (path: string) => void;
	/** Told just before a scaffold writes the new app's files. */
	private readonly onScaffold?: () => void;

	/**
	 * Builds the toolkit.
	 *
	 * @param opts - Timing: how often to read the build's progress (default 3 s) and how long to wait for it (default 540 s); the run's stop signal; what hides the values the run's file tools hid before a build log is cut; what hears each file create_app wrote; and who to tell before a scaffold writes files.
	 */
	constructor(client: ClientGetter, host: AgentHost, opts: { pollMs?: number; buildWaitMs?: number; signal?: AbortSignal; hide?: (text: string) => string; created?: (path: string) => void; onScaffold?: () => void } = {}) {
		super();
		this.client = client;
		this.host = host;
		this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
		this.buildWaitMs = opts.buildWaitMs ?? DEFAULT_BUILD_WAIT_MS;
		this.signal = opts.signal;
		this.hide = opts.hide ?? ((text) => text);
		this.created = opts.created;
		this.onScaffold = opts.onScaffold;
	}

	/**
	 * Scaffolds a new app. Free.
	 *
	 * @returns The new app's id and folder.
	 * @throws When a name is wrong, the folder is taken, or the scaffold fails.
	 */
	private async create(args: Record<string, unknown>): Promise<string> {
		const appName = textArg(args, 'appName');
		if (!appName) throw new Error("appName is required. Give a short lowercase name such as 'daybook'; the app's folder is named after it.");
		if (!APP_NAME_RE.test(appName)) {
			throw new Error(`appName '${appName}' isn't valid. Start with a lowercase letter, then use only letters, digits, hyphens and underscores, for example 'daybook'.`);
		}
		const displayName = textArg(args, 'displayName');
		if (!displayName) throw new Error("displayName is required. It's the name people see, for example 'Daybook'.");
		const template = textArg(args, 'template') || 'Blank';
		if (!(TEMPLATES as readonly string[]).includes(template)) throw new Error(`template must be ${TEMPLATES.join(' or ')}. Leave it out for Blank.`);

		const path = `apps/${appName}-ui`;
		if ((await this.host.vfs.stat(path)) !== null) throw new Error(`${path} already exists. Pick another appName, or edit that app instead.`);

		this.onScaffold?.();
		let folder = `${appName}-ui`;
		try {
			const made = await this.host.scaffoldApp({ appName, displayName, template: template as (typeof TEMPLATES)[number] });
			folder = made.folder;
			return `Created ${made.appId} in apps/${made.folder}.`;
		} finally {
			// step: the scaffold writes past the file toolkit, and its folder was new, so every file in it is one
			// the run created, also when the scaffold failed after writing some of them
			for (const entry of this.host.vfs.listEntries()) {
				if (entry.type === 'file' && entry.path.startsWith(`apps/${folder}/`)) this.created?.(entry.path);
			}
		}
	}

	/**
	 * Uploads an app as its next version and waits for the server build. Free.
	 *
	 * @returns Whether the server build is OK, failed (with its log) or still running.
	 * @throws When the app cannot be packed or uploaded; packing errors pass through unchanged.
	 */
	private async deploy(args: Record<string, unknown>): Promise<string> {
		const app = await appArg(this.host, args, 'deployed');
		const message = textArg(args, 'message');
		if (!message) throw new Error('message is required. Say in a few words what changed; the registry keeps it with the version.');
		const client = requireClient(this.client);

		const data = await this.host.packApp(app.folder);
		const before = newestFirst(await client.listDeployments(app.id))[0]?.registryVersion ?? 0;
		let reply: unknown;
		try {
			reply = await client.deploy.add({ kind: 'app', data, comment: message });
		} catch (err) {
			throw messageOf(err).includes('registered developer id') ? new Error(NO_DEVELOPER_MESSAGE) : err;
		}

		// The version is registered now; a failure from here on must not read as a failed upload.
		try {
			return await this.waitForBuild(client, app.id, before, uploadedVersion(reply));
		} catch (err) {
			throw new Error(`The new version of ${app.id} was uploaded, but reading its build failed: ${messageOf(err)}. Don't deploy again for this change; tell the user to check the version list in the app's Deploy view.`);
		}
	}

	/**
	 * Watches the version just uploaded until its build finishes or the wait runs out. A teammate's
	 * deploy can land beside ours, so the version is fixed once: the one the upload's reply names,
	 * else the first to appear above `before`.
	 */
	private async waitForBuild(client: RocketRideClient, appId: string, before: number, uploaded: number | undefined): Promise<string> {
		const deadline = Date.now() + this.buildWaitMs;
		let target = uploaded;
		let version: Version | undefined;
		for (;;) {
			const rail = await client.listDeployments(appId);
			if (target === undefined)
				target = newestFirst(rail)
					.filter((v) => v.registryVersion > before)
					.at(-1)?.registryVersion;
			version = rail.find((v) => v.registryVersion === target) ?? version;
			if (version) {
				const state = buildStateOf(version);
				if (state === 'ok') return `Deployed v${version.registryVersion}; server build OK.`;
				if (state === 'failed') {
					const { log } = await client.buildLog(appId, version.registryVersion);
					// hide and redact before the cut: a cut inside a value leaves a part nothing matches
					return `Deployed v${version.registryVersion}; server build FAILED:\n${redactText(this.hide(log)).slice(-BUILD_LOG_TAIL_CHARS) || '(the build recorded no log)'}`;
				}
			}
			if (Date.now() >= deadline || this.signal?.aborted) break;
			await sleep(this.pollMs, this.signal);
		}

		const waited = this.signal?.aborted ? 'when the run was stopped' : `after ${Math.round(this.buildWaitMs / 1000)} s`;
		if (target === undefined) return `Deployed, but the new version isn't on the version list ${waited}. Tell the user to check the app's Deploy view.`;
		return `Deployed v${target}; the server build is still running (${version?.buildStatus ?? 'queued'}) ${waited}.`;
	}

	/**
	 * Gets a publish ready: checks the arguments, picks the version, and names
	 * the client call that publishes or submits it. Only reads.
	 *
	 * @returns The step: its act and run, or a run that only reports when there is nothing to do.
	 * @throws When an argument is wrong or the version cannot serve yet.
	 */
	private async preparePublish(args: Record<string, unknown>): Promise<ToolStep> {
		const app = await appArg(this.host, args, 'published');
		const target = textArg(args, 'target') as Target;
		if (!TARGETS.includes(target)) throw new Error("target must be 'me', 'team' or 'public'.");
		const team = textArg(args, 'team');
		if (target === 'team' && !team) throw new Error("team is required when target is 'team'. Pass the team's name or id.");
		const requested = numberArg(args, 'version', true);
		if (requested !== undefined && requested < 1) throw new Error('version must be a whole number, 1 or more. Leave it out for the newest built version.');
		const client = requireClient(this.client);

		const version = this.versionToPublish(app, await client.listDeployments(app.id), requested);
		const step = this.planFor(client, app, version, target, team);
		return typeof step === 'string' ? { run: async () => step } : step;
	}

	/**
	 * Picks the version to publish and checks it can serve.
	 *
	 * @param requested - The version the call named, if any.
	 * @returns The version: the one named, or the newest whose build is OK.
	 * @throws When the version is missing, or its build failed or is still running.
	 */
	private versionToPublish(app: IdentifiedApp, rail: Version[], requested: number | undefined): Version {
		const versions = newestFirst(rail);
		if (requested === undefined) {
			const built = versions.find((v) => buildStateOf(v) === 'ok');
			if (!built) throw new Error(`${app.id} has no version with a finished server build yet. Call deploy_app, which waits for the build, then publish.`);
			return built;
		}

		const found = versions.find((v) => v.registryVersion === requested);
		if (!found) {
			const known = versions.map((v) => `v${v.registryVersion}`).join(', ');
			throw new Error(`${app.id} has no v${requested}. Versions: ${known || 'none; call deploy_app first'}.`);
		}
		const state = buildStateOf(found);
		if (state === 'failed') throw new Error(`v${requested} of ${app.id} can't be published: its server build failed. Fix the app and call deploy_app for a new version.`);
		if (state === 'running') throw new Error(`v${requested} of ${app.id} can't be published yet: its server build is still running (${found.buildStatus}). Try again when it finishes.`);
		return found;
	}

	/**
	 * Works out what publishing a version to an audience does. Public follows the
	 * review ladder by the version's state: private is submitted for review, one
	 * already waiting is left alone, and an approved one is bound.
	 *
	 * @returns The client call to make, as act and run; or the final text, when there is nothing to do.
	 * @throws When the version's state cannot be published to everyone.
	 */
	private planFor(client: RocketRideClient, app: IdentifiedApp, version: Version, target: Target, team: string): ToolStep | string {
		const n = version.registryVersion;
		const bind = (audience: string): ToolStep => ({
			act: { name: 'publishApp', params: [app.id, n, audience] },
			run: async () => {
				await client.publishApp(app.id, n, audience);
				return `Published v${n} to ${audienceWords(target, team)}.`;
			},
		});

		if (target === 'me') return bind('@me');
		if (target === 'team') return bind(`@team/${team}`);

		switch (version.state) {
			case 'private':
				return {
					act: { name: 'submitApp', params: [app.id, n] },
					run: async () => {
						await client.submitApp(app.id, n);
						return `Submitted v${n} for review; it goes public after an admin approves it.`;
					},
				};
			case 'submit':
				return `v${n} is already waiting for review.`;
			case 'ready':
				return bind('@public');
			default:
				throw new Error(`v${n} of ${app.id} is '${version.state}', so it can't go public. Call deploy_app for a new version and publish that.`);
		}
	}

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'create_app',
				description: ['Create a new app from a template, in apps/<appName>-ui.', '- appName is a short lowercase name that starts with a letter, such as daybook; the folder is named after it, and a name already taken is refused.', '- template is Blank (the default) or Dashboard.', "- It returns the new app's id. Edit the app with the file tools, then run check_app on it."].join('\n'),
				parameters: {
					type: 'object',
					properties: {
						appName: { type: 'string', pattern: APP_NAME_RE.source, description: "Short name: a lowercase letter, then letters, digits, '-' or '_' (for example daybook). The folder becomes <appName>-ui" },
						displayName: { type: 'string', description: "The name people see (for example 'Daybook')" },
						template: { type: 'string', enum: [...TEMPLATES], description: 'Starting point (default Blank)' },
					},
					required: ['appName', 'displayName'],
					additionalProperties: false,
				},
				execute: (args) => this.create(args),
			}),
			new AgentTool({
				name: 'deploy_app',
				description: DEPLOY_DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						app: { type: 'string', description: "The app's folder name, manifest id or name; list_workspace shows them" },
						message: { type: 'string', description: 'What changed, in a few words; kept with the version' },
					},
					required: ['app', 'message'],
					additionalProperties: false,
				},
				execute: (args) => this.deploy(args),
			}),
			new AgentTool({
				name: 'publish_app',
				description: PUBLISH_DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						app: { type: 'string', description: "The app's folder name, manifest id or name; list_workspace shows them" },
						target: { type: 'string', enum: [...TARGETS], description: "'me' for the user alone, 'team' for a team (set team), 'public' for everyone (goes through review)" },
						team: { type: 'string', description: "The team's name or id; required when target is 'team'" },
						version: { type: 'integer', minimum: 1, description: 'Registry version to publish (default: the newest whose server build is OK)' },
					},
					required: ['app', 'target'],
					additionalProperties: false,
				},
				prepare: (args) => this.preparePublish(args),
			}),
		];
	}
}
