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
// APPROVAL — which agent actions run, which ask the user first, which never run
// =============================================================================

/**
 * One list rates every action an agent tool can take outside its workspace
 * edits: each RocketRide client method by the name the guide uses
 * (`publishApp`, `deploy.setSchedule`), plus the one tool whose work bypasses
 * the client (`delete_file`). Each entry is free, ask or never. A name the list
 * lacks asks. The model never rates its own risk: the list is ours, and its
 * type is built from the client's own type, so tsc refuses a client method
 * with no row, a row for a method the client lacks, and an ask on a sync
 * method (it can't wait for a card).
 *
 * The loop calls `Approvals.approve` between a call's prepare and its run,
 * with the call's clock stopped:
 *
 * - free:  the run starts at once.
 * - ask:   in Auto mode, or with the entry's grant on, the run starts at once.
 *          Otherwise a "Needs your OK" card waits in the chat. Approve starts
 *          the run; Deny and Stop refuse it, as the call's error.
 * - never: refused in every mode, as the call's error.
 *
 * The client the toolkits get is a checked view of the real one
 * (`Approvals.client`). It refuses never methods, and refuses an ask method
 * unless the running call announced exactly that call (method and arguments)
 * and it was let through. That backstop keeps the rule fail closed for a tool
 * that forgets to say what it will do. The model's own `chat` keeps the real
 * client.
 *
 * This is a check on the agent's own tool calls, not a security boundary: the
 * app preview holds the user's token and can call anything.
 */

import type { RocketRideClient } from 'rocketride';
import type { ChatAskAnswer, ChatAskCard, ChatAsking } from 'shell/src/components/chat/types';

import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import type { ApprovalPrefs, ApprovalSettings, Grant } from '../host';
import type { ToolAct } from '../tools';
import { brief, isJsonObject, requireClient, type ClientGetter } from './common';
import { readApps } from './inventory';

// =============================================================================
// TYPES
// =============================================================================

/** Any function. `never[]` parameters let every method signature match. */
type Fn = (...args: never[]) => unknown;

/** The names of an object's public methods (keyof drops private and protected members). */
type MethodsOf<T> = { [K in keyof T & string]: T[K] extends Fn ? K : never }[keyof T & string];

/** The client's sub-clients: its public object-valued fields (`deploy`, `account`). `_`-named fields are its internals. */
type SubClient = { [K in keyof RocketRideClient & string]: K extends `_${string}` ? never : RocketRideClient[K] extends Fn ? never : RocketRideClient[K] extends object ? K : never }[keyof RocketRideClient & string];

/** Every public client method, named as rocketride_client takes it: `use`, `deploy.add`. */
type ClientMethod = MethodsOf<RocketRideClient> | { [S in SubClient]: `${S}.${MethodsOf<RocketRideClient[S]>}` }[SubClient];

/** The method a name points at. */
type MethodAt<M extends string> = M extends `${infer S extends SubClient}.${infer L}` ? RocketRideClient[S][L & keyof RocketRideClient[S]] : RocketRideClient[M & keyof RocketRideClient];

/** The display names a card uses. Each falls back to the id it was given, and waits at most LOOKUP_LIMIT_MS. */
interface Names {
	/** `Daybook (acme.daybook)`, or the id. */
	app(appId: unknown): Promise<string>;
	/** `Staging`, or the id. */
	team(teamId: unknown): Promise<string>;
	/** The deployed pipeline's name, or the project id. */
	deployment(projectId: unknown, teamId: unknown): Promise<string>;
	/** A schedule's next few runs, as dates, or '' when the server can't say. */
	nextRuns(schedule: string): Promise<string>;
}

/** What a card shows before the shell adds its buttons. */
type Card = Pick<ChatAskCard, 'title' | 'detail'>;

/** Builds a card from a call's own arguments. They come from the model, so a builder reads them defensively. */
type CardBuilder = (params: readonly unknown[], names: Names) => Promise<Card>;

/** An entry that never runs, and what to do instead. */
interface NeverRule {
	readonly tier: 'never';
	/** The tail of the refusal the model reads. */
	readonly why: string;
}

/** An entry that asks. */
interface AskRule {
	readonly tier: 'ask';
	/** The card, in the user's words, from the call's own arguments. */
	readonly card: CardBuilder;
	/** The grant that lets it run without a card. Only routine kinds have one. */
	readonly grant?: Grant;
	/** True for arguments that make the call free (deploy.add with no deployTo points no team at the version). */
	readonly freeWhen?: (params: readonly unknown[]) => boolean;
}

/** How the list rates one name. */
type Rule = 'free' | NeverRule | AskRule;

/** How the list rates a sync method: it can't wait for a card. */
type SyncRule = 'free' | NeverRule;

/** One row per public client method, and only those: tsc refuses a missing method, a name the client lacks, and an ask on a sync method. */
type ClientPolicy = { readonly [M in ClientMethod]: MethodAt<M> extends (...args: never[]) => PromiseLike<unknown> ? Rule : SyncRule };

/** What one run's approvals need. */
export interface ApprovalsOptions {
	/** The real client. Toolkits get the checked view (`Approvals.client`); card names read through this one. */
	client: ClientGetter;
	/** The workspace view, for app names on cards. */
	vfs: IWorkspaceFileSystem;
	/** Shows a "Needs your OK" card in the chat: the turn's ask. Absent: nothing that needs asking runs in Ask mode. */
	ask?: (card: ChatAskCard) => ChatAsking;
	/** The user's mode and grants. Absent: Ask, nothing granted. */
	settings?: ApprovalSettings;
	/** The run's stop signal: once aborted no card waits and no asked method runs. */
	signal: AbortSignal;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Ask mode, nothing granted: what a run without settings gets. */
const DEFAULT_PREFS: ApprovalPrefs = { mode: 'ask', grants: { schedules: false, deploymentToggles: false } };

/** The "Always allow" button's label per grant. */
const ALWAYS_LABELS: Readonly<Record<Grant, string>> = {
	schedules: 'Always allow schedule changes',
	deploymentToggles: 'Always allow turning deployments on and off',
};

/** The longest a card waits for one name lookup, in milliseconds. */
const LOOKUP_LIMIT_MS = 2_000;

/** How many upcoming runs a schedule card shows. */
const NEXT_RUNS = 3;

/** The tails of the never refusals; the credential ones are rocketride_client's old words. */
const CONNECTION = "the client is the user's own connection, already signed in; leave it as it is";
const SIGNED_IN = 'the client is already connected and signed in as the user';
const PLUMBING = "it is the client's protocol plumbing, not part of its API";
const RAW = 'call the client method that wraps the command instead';
const FILES = "the fs methods write the store directly, skipping the file tools' checks and save-time validation; use the file tools";
const ACCOUNT = 'ask the user to make account, team and member changes themselves';
const BILLING = 'ask the user to go through billing themselves';
const ACCOUNT_DETAILS = 'use getOrgId, account.getOrg or account.listTeams for account details';
const MONITORS = 'monitors belong to the open app; poll getTaskStatus(token) instead';

// =============================================================================
// TEXTS — what the model reads as the call's error
// =============================================================================

/** A never entry. */
function blocked(name: string, why: string): string {
	return `${name} is blocked: ${why}.`;
}

/** The user said no. */
function declined(title: string): string {
	return `The user declined: ${title}. Don't retry it; ask the user what they want instead.`;
}

/** The run was stopped before the user answered. */
function notAnswered(title: string): string {
	return `Not done: the user stopped the run before answering: ${title}.`;
}

/** Nowhere to show the card. */
function noChat(title: string): string {
	return `Not done: ${title} needs the user's OK, and there is no chat to ask in.`;
}

/** The backstop: an ask method the running call never announced. */
function unannounced(name: string): string {
	return `${name} needs the user's OK, and the call that reached it didn't say it would make it, so it was refused. Call it with rocketride_client, which asks.`;
}

/** The backstop after Stop. */
function afterStop(name: string): string {
	return `Not done: the run was stopped, so ${name} was not called.`;
}

// =============================================================================
// THE LIST
// =============================================================================

/** A free row. */
const FREE = 'free';

/** A never row. */
function never(why: string): NeverRule {
	return { tier: 'never', why };
}

/** An ask row. */
function ask(card: CardBuilder, extra: Pick<AskRule, 'grant' | 'freeWhen'> = {}): AskRule {
	return { tier: 'ask', card, ...extra };
}

/**
 * The one list: every public client method, by the name rocketride_client
 * takes. Reads and pipeline work are free.
 */
const CLIENT_POLICY: ClientPolicy = {
	// The connection and the client's plumbing
	connect: never(SIGNED_IN),
	login: never(SIGNED_IN),
	logout: never(CONNECTION),
	disconnect: never(CONNECTION),
	attach: never(CONNECTION),
	detach: never(CONNECTION),
	_dapConnect: never(CONNECTION),
	identify: never(CONNECTION),
	setEnv: never("pass values as ${ROCKETRIDE_<NAME>} placeholders; setEnv changes the open app's client"),
	getAccountInfo: never(ACCOUNT_DETAILS),
	getApiKey: never('the client is already signed in as the user, so you never need the key'),
	call: never(RAW),
	request: never(RAW),
	onEvent: never(PLUMBING),
	onConnected: never(PLUMBING),
	onConnectError: never(PLUMBING),
	onDisconnected: never(PLUMBING),
	onReceive: never(PLUMBING),
	raiseException: never(PLUMBING),
	debugMessage: never(PLUMBING),
	debugProtocol: never(PLUMBING),
	didFail: never(PLUMBING),
	getWebResponse: never(PLUMBING),
	buildRequest: never(PLUMBING),
	buildResponse: never(PLUMBING),
	buildEvent: never(PLUMBING),
	buildError: never(PLUMBING),
	buildException: never(PLUMBING),
	isAttached: FREE,
	isAuthenticated: FREE,
	isConnected: FREE,
	getConnectionInfo: FREE,
	getOrgId: FREE,
	ping: FREE,

	// Pipelines: run, talk to, watch
	validate: FREE,
	use: FREE,
	send: FREE,
	sendFiles: FREE,
	pipe: FREE,
	chat: FREE,
	tool: FREE,
	getTasks: FREE,
	getTaskStatus: FREE,
	getTaskToken: FREE,
	getTaskPipeline: FREE,
	addMonitor: FREE,
	setEvents: FREE,
	terminate: FREE,
	restart: FREE,
	removeMonitor: never(MONITORS),
	clearAllMonitors: never(MONITORS),

	// Server state
	getServices: FREE,
	getService: FREE,
	getDashboard: FREE,
	listConnections: FREE,
	listTasks: FREE,
	cprofileStatus: FREE,
	cprofileReport: FREE,
	cprofileReportTree: FREE,
	cprofileThreads: FREE,
	cprofileStart: ask(async () => ({ title: 'Start profiling the server' })),
	cprofileStop: ask(async () => ({ title: 'Stop profiling the server' })),

	// Templates and saved logs, in the user's server-side store
	getTemplate: FREE,
	getAllTemplates: FREE,
	getLog: FREE,
	listLogs: FREE,
	saveTemplate: ask(async ([o]) => ({ title: `Save the pipeline template ${field(o, 'templateId')}`, detail: 'A template with that id is overwritten.' })),
	deleteTemplate: ask(async ([o]) => ({ title: `Delete the pipeline template ${field(o, 'templateId')}` })),
	saveLog: ask(async () => ({ title: 'Save a run log to your store' })),
	deleteLog: ask(async ([o]) => ({ title: `Delete the saved run log ${field(o, 'name')}` })),

	// The store: every fs method
	fsOpen: never(FILES),
	fsRead: never(FILES),
	fsWrite: never(FILES),
	fsClose: never(FILES),
	fsDelete: never(FILES),
	fsListDir: never(FILES),
	fsMkdir: never(FILES),
	fsRmdir: never(FILES),
	fsStat: never(FILES),
	fsRename: never(FILES),
	fsGetUrl: never(FILES),
	fsReadMany: never(FILES),
	fsReadString: never(FILES),
	fsWriteString: never(FILES),
	fsReadJson: never(FILES),
	fsWriteJson: never(FILES),

	// Apps: versions, review, publishing
	listDeployments: FREE,
	buildLog: FREE,
	whereApp: FREE,
	publishApp: ask(publishCard),
	submitApp: ask(async ([appId, version], n) => ({ title: `Submit ${await n.app(appId)} v${text(version)} for review`, detail: 'It goes public only after an admin approves it.' })),
	withdrawApp: ask(async ([appId, version], n) => ({ title: `Withdraw ${await n.app(appId)} v${text(version)} from review` })),
	replyApp: ask(async ([appId, message], n) => ({ title: `Reply to the review of ${await n.app(appId)}`, detail: quoted(message) })),
	removeAppPublish: ask(async ([appId, target], n) => ({ title: `Unpublish ${await n.app(appId)} from ${(await audience(target, n)).words}`, detail: 'People there can no longer open it.' })),
	disableAppPublish: ask(async ([appId, target], n) => ({ title: `Turn off ${await n.app(appId)} for ${(await audience(target, n)).words}` })),

	// account
	'account.getOrg': FREE,
	'account.listKeys': FREE,
	'account.listMembers': FREE,
	'account.listTeams': FREE,
	'account.getTeamDetail': FREE,
	'account.getEnvironmentKeys': FREE,
	'account.getProfile': never(ACCOUNT_DETAILS),
	'account.getEnv': never('use account.getEnvironmentKeys for the names, and ${ROCKETRIDE_<NAME>} placeholders in pipelines'),
	'account.createKey': never('ask the user to create API keys in their settings'),
	'account.setDevTeam': ask(async ([teamId], n) => ({ title: `Make team ${await n.team(teamId)} your development team`, detail: 'Dev runs bill to it and use its environment, and the workspace reloads.' })),
	'account.updateProfile': never(ACCOUNT),
	'account.setDefaultOrg': never(ACCOUNT),
	'account.deleteAccount': never(ACCOUNT),
	'account.updateOrgName': never(ACCOUNT),
	'account.revokeKey': never(ACCOUNT),
	'account.inviteMember': never(ACCOUNT),
	'account.resendInvite': never(ACCOUNT),
	'account.updateMemberRole': never(ACCOUNT),
	'account.removeMember': never(ACCOUNT),
	'account.createTeam': never(ACCOUNT),
	'account.deleteTeam': never(ACCOUNT),
	'account.addTeamMember': never(ACCOUNT),
	'account.updateTeamMemberPerms': never(ACCOUNT),
	'account.removeTeamMember': never(ACCOUNT),
	'account.setEnv': never(ACCOUNT),

	// billing
	'billing.getDetails': FREE,
	'billing.getProductPrices': FREE,
	'billing.validatePromoCode': FREE,
	'billing.getCreditBalance': FREE,
	'billing.listCreditPacks': FREE,
	'billing.getTransactions': FREE,
	'billing.getTransactionDistinct': FREE,
	'billing.getUsageByUser': FREE,
	'billing.getUsageByTeam': FREE,
	'billing.createCheckoutSession': never(BILLING),
	'billing.createCreditCheckout': never(BILLING),
	'billing.purchaseTopup': never(BILLING),
	'billing.createPortalSession': never('ask the user to open billing themselves'),
	'billing.redeemPromoCode': never(BILLING),
	'billing.cancelSubscription': never(BILLING),
	'billing.upgradeSubscription': never(BILLING),

	// database: SQL on a database node of a pipeline the agent runs
	'database.query': ask(async ([o]) => ({ title: 'Run SQL on a pipeline database', detail: brief(field(o, 'sql')) })),
	'database.beginTransaction': FREE,
	'database.commit': FREE,
	'database.rollback': FREE,
	'database.dialect': FREE,
	'database.sequelize': FREE,

	// deploy
	'deploy.add': ask(deployToCard, { freeWhen: ([o]) => !isJsonObject(o) || o.deployTo === undefined }),
	'deploy.addApp': FREE,
	'deploy.createApp': FREE,
	'deploy.verifyApp': FREE,
	'deploy.list': FREE,
	'deploy.get': FREE,
	'deploy.versions': FREE,
	'deploy.artifact': FREE,
	'deploy.history': FREE,
	'deploy.preview': FREE,
	'deploy.deploy': ask(async ([projectId, version, teamId], n) => ({ title: `Point team ${await n.team(teamId)} at v${text(version)} of ${await n.deployment(projectId, teamId)}`, detail: 'That team runs this version from now on.' })),
	'deploy.remove': ask(async ([projectId, teamId], n) => ({ title: `Remove ${await n.deployment(projectId, teamId)} from team ${await n.team(teamId)}`, detail: 'Its schedules stop and it no longer runs there.' })),
	'deploy.enable': ask(async ([projectId, teamId], n) => ({ title: `Turn on ${await n.deployment(projectId, teamId)} for team ${await n.team(teamId)}` }), { grant: 'deploymentToggles' }),
	'deploy.disable': ask(async ([projectId, teamId], n) => ({ title: `Turn off ${await n.deployment(projectId, teamId)} for team ${await n.team(teamId)}`, detail: 'Nothing runs there until it is turned on again.' }), { grant: 'deploymentToggles' }),
	'deploy.setSchedule': ask(scheduleCard, { grant: 'schedules' }),
	'deploy.pauseSchedule': ask(async ([projectId, sourceId, teamId], n) => ({ title: `Pause the schedule of ${await n.deployment(projectId, teamId)} (${text(sourceId)}) on team ${await n.team(teamId)}` }), { grant: 'schedules' }),
	'deploy.resumeSchedule': ask(async ([projectId, sourceId, teamId], n) => ({ title: `Resume the schedule of ${await n.deployment(projectId, teamId)} (${text(sourceId)}) on team ${await n.team(teamId)}` }), { grant: 'schedules' }),
	'deploy.run': ask(async ([projectId, sourceId, teamId], n) => ({ title: `Run ${await n.deployment(projectId, teamId)} (${text(sourceId)}) on team ${await n.team(teamId)} now` })),
	'deploy.setSourceConfig': ask(async ([projectId, sourceId, teamId], n) => ({ title: `Change tracing for ${await n.deployment(projectId, teamId)} (${text(sourceId)}) on team ${await n.team(teamId)}` })),

	// log
	'log.openEventStream': FREE,
	'log.chapters': FREE,
	'log.streams': FREE,
	'log.read': FREE,
	'log.segment': FREE,
	'log.delete': ask(async ([stream]) => ({ title: `Delete run logs of ${field(stream, 'source')} in ${field(stream, 'projectId')}` })),
};

/** The list by plain name, for lookups at run time. */
const CLIENT_RULES: Readonly<Record<string, Rule>> = CLIENT_POLICY;

/** The tool acts: tools whose work does not go through the client. Their params are their target. */
const TOOL_LIST: Readonly<Record<string, Rule>> = {
	delete_file: ask(async ([path, type]) => ({ title: type === 'dir' ? `Delete the folder ${text(path)} and everything in it` : `Delete ${text(path)}`, detail: 'There is no undo.' })),
};

/** What a name the list lacks gets: ask, with a plain card. */
function unlisted(name: string): AskRule {
	return ask(async (params) => ({ title: `Call ${name}`, detail: `With ${brief(JSON.stringify(params) ?? '[]')}` }));
}

/**
 * How one call is rated.
 *
 * @param name - The client method, or the tool act when `acts` is set.
 * @param params - The call's arguments.
 * @param acts - Whether a tool act may match (the approve step); the checked client only rates client methods.
 * @returns Its rule for these arguments; an ask whose arguments make it free is free.
 */
function rate(name: string, params: readonly unknown[], acts: boolean): Rule {
	const rule = (acts && Object.hasOwn(TOOL_LIST, name) ? TOOL_LIST[name] : undefined) ?? (Object.hasOwn(CLIENT_RULES, name) ? CLIENT_RULES[name] : unlisted(name));
	return rule !== FREE && rule.tier === 'ask' && rule.freeWhen?.(params) ? FREE : rule;
}

/** Whether the settings let an ask run without a card: Auto, or its grant on. */
function allowed(rule: AskRule, prefs: ApprovalPrefs): boolean {
	return prefs.mode === 'auto' || (rule.grant !== undefined && prefs.grants[rule.grant]);
}

// =============================================================================
// CARDS — the action and its target, in the user's words
// =============================================================================

/** publishApp(appId, version, target): "Publish <app> v<n> to <audience>", with what it does. */
async function publishCard([appId, version, target]: readonly unknown[], names: Names): Promise<Card> {
	const to = await audience(target, names);
	return { title: `Publish ${await names.app(appId)} v${text(version)} to ${to.words}`, detail: to.effect };
}

/** deploy.add({ pipeline, deployTo }) with deployTo: the new version goes live on that team. */
async function deployToCard([o]: readonly unknown[], names: Names): Promise<Card> {
	const pipeline = isJsonObject(o) && isJsonObject(o.pipeline) && typeof o.pipeline.name === 'string' ? o.pipeline.name : 'the pipeline';
	return { title: `Deploy a new version of ${pipeline} to team ${await names.team(isJsonObject(o) ? o.deployTo : undefined)}`, detail: 'That team runs this version from now on.' };
}

/**
 * deploy.setSchedule(projectId, sourceId, schedule, teamId): what the schedule
 * becomes, and its next runs when the server can say.
 */
async function scheduleCard([projectId, sourceId, schedule, teamId]: readonly unknown[], names: Names): Promise<Card> {
	const where = `${await names.deployment(projectId, teamId)} (${text(sourceId)}) on team ${await names.team(teamId)}`;
	if (schedule === null) return { title: `Clear the schedule of ${where}`, detail: 'It stops running on a schedule.' };
	const next = await names.nextRuns(text(schedule));
	return { title: `Schedule ${where} to run ${text(schedule)}`, detail: next ? `Next runs: ${next}.` : undefined };
}

/** A publish target in the user's words, and what binding it does. */
async function audience(target: unknown, names: Names): Promise<{ words: string; effect?: string }> {
	if (target === '@me' || target === '@user') return { words: 'you', effect: 'Only you can open it.' };
	if (target === '@public') return { words: 'everyone', effect: 'It is approved, so it goes live to everyone straight away.' };
	if (typeof target === 'string' && target.startsWith('@team/')) return { words: `team ${await names.team(target.slice('@team/'.length))}`, effect: 'Everyone on that team can open it.' };
	return { words: text(target) };
}

/** A model-supplied argument as card text: a string as it is, anything else as short JSON. */
function text(value: unknown): string {
	return typeof value === 'string' ? value : brief(JSON.stringify(value) ?? String(value));
}

/** One field of an options argument, as card text. */
function field(options: unknown, name: string): string {
	return text(isJsonObject(options) ? options[name] : undefined);
}

/** A message as a quoted, short card detail. */
function quoted(message: unknown): string {
	return `"${brief(text(message))}"`;
}

/**
 * Resolves with a lookup's name, or with the fallback when the lookup fails,
 * takes longer than LOOKUP_LIMIT_MS, or the run is stopped.
 */
function capped(lookup: () => Promise<string>, fallback: string, signal: AbortSignal): Promise<string> {
	if (signal.aborted) return Promise.resolve(fallback);
	return new Promise((resolve) => {
		const settle = (name: string): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', stop);
			resolve(name || fallback);
		};
		const stop = (): void => settle(fallback);
		const timer = setTimeout(stop, LOOKUP_LIMIT_MS);
		signal.addEventListener('abort', stop, { once: true });
		Promise.resolve().then(lookup).then(settle, stop);
	});
}

/**
 * The names cards use for one run, read through the real client and the
 * workspace. The team list is kept once a read of it succeeds. Every lookup
 * ends when the run is stopped, so a stopped card is not held up by them.
 */
function cardNames(client: ClientGetter, vfs: IWorkspaceFileSystem, signal: AbortSignal): Names {
	let teams: ReadonlyMap<string, string> | undefined;
	const teamNames = async (): Promise<ReadonlyMap<string, string>> => {
		if (teams) return teams;
		const real = requireClient(client);
		const org = real.getOrgId();
		if (!org) return new Map();
		return (teams = new Map((await real.account.listTeams(org)).map((team) => [team.id, team.name])));
	};
	return {
		app: (appId) =>
			capped(
				async () => {
					const found = (await readApps(vfs, () => false)).find((app) => app.id === appId);
					return found?.name ? `${found.name} (${text(appId)})` : text(appId);
				},
				text(appId),
				signal
			),
		team: (teamId) => capped(async () => (await teamNames()).get(text(teamId)) ?? text(teamId), text(teamId), signal),
		deployment: (projectId, teamId) => capped(async () => (await requireClient(client).deploy.get(text(projectId), text(teamId))).pipelineName ?? text(projectId), text(projectId), signal),
		nextRuns: (schedule) =>
			capped(
				async () => {
					const preview = await requireClient(client).deploy.preview(schedule, NEXT_RUNS);
					return (preview.next ?? []).map((seconds) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })).join(', ');
				},
				'',
				signal
			),
	};
}

// =============================================================================
// THE RUN'S APPROVALS
// =============================================================================

/**
 * One run's approvals: the approve step the loop calls, and the checked
 * client the toolkits get. They share one record of what was let through, the
 * passes, so the two can never disagree.
 */
export class Approvals {
	/** The checked client view: hand it to every toolkit and the save hook, never to the model call. */
	readonly client: ClientGetter;

	/** The passes of asked calls let through and still running, by `name(params)`. One pass is one call. */
	private readonly passes = new Map<string, Set<object>>();
	/** The checked view of each client object, so identity holds within a run. */
	private readonly views = new WeakMap<object, object>();
	/** The names cards use. */
	private readonly names: Names;

	/**
	 * @param o - The real client, the workspace, the turn's ask, the settings and the stop signal.
	 */
	constructor(private readonly o: ApprovalsOptions) {
		this.names = cardNames(o.client, o.vfs, o.signal);
		this.client = () => {
			const real = o.client();
			return real ? (this.view(real, '') as RocketRideClient) : null;
		};
	}

	/**
	 * Lets a prepared call start, or refuses it. The loop calls it with the
	 * call's clock stopped. While a card waits, every settings change decides
	 * it again, so switching to Auto, or turning its grant on, approves it.
	 *
	 * @param act - What the call is about to do.
	 * @param run - The call's work.
	 * @returns The work to start: `run` itself for a free act, or `run` holding a pass for an asked one.
	 * @throws The refusal the model reads: blocked, declined, or not answered.
	 */
	async approve(act: ToolAct, run: () => Promise<string>): Promise<() => Promise<string>> {
		const rule = rate(act.name, act.params, true);
		if (rule === FREE) return run;
		if (rule.tier === 'never') throw new Error(blocked(act.name, rule.why));
		if (allowed(rule, this.prefs())) return this.withPass(act, run);

		const card = await rule.card(act.params, this.names);
		if (this.o.signal.aborted) throw new Error(notAnswered(card.title));
		// the settings may have changed while the names were looked up
		if (allowed(rule, this.prefs())) return this.withPass(act, run);
		if (!this.o.ask) throw new Error(noChat(card.title));

		// without settings an Always click would save nothing
		const asking = this.o.ask(rule.grant && this.o.settings ? { ...card, alwaysLabel: ALWAYS_LABELS[rule.grant] } : card);
		const off = this.o.settings?.subscribe(() => {
			if (allowed(rule, this.prefs())) asking.approve();
		});
		let answer: ChatAskAnswer;
		try {
			answer = await untilStopped(asking.answer, this.o.signal);
		} finally {
			off?.();
		}

		if (answer === 'always' && rule.grant) this.o.settings?.grant(rule.grant);
		if (answer === 'deny') throw new Error(declined(card.title));
		// a click that raced Stop runs nothing
		if (answer === 'stopped' || this.o.signal.aborted) throw new Error(notAnswered(card.title));
		return this.withPass(act, run);
	}

	/** The user's settings now. */
	private prefs(): ApprovalPrefs {
		return this.o.settings?.read() ?? DEFAULT_PREFS;
	}

	/**
	 * Wraps a let-through run so the checked client accepts the one call it
	 * announced. The pass is added when the run starts and dropped when it
	 * settles, used or not.
	 */
	private withPass(act: ToolAct, run: () => Promise<string>): () => Promise<string> {
		const key = passKey(act.name, act.params);
		return async () => {
			const pass = {};
			const held = this.passes.get(key) ?? new Set<object>();
			this.passes.set(key, held.add(pass));
			try {
				return await run();
			} finally {
				held.delete(pass);
				if (held.size === 0 && this.passes.get(key) === held) this.passes.delete(key);
			}
		};
	}

	/** Takes one pass for a call, if a let-through run holds one. */
	private take(key: string): boolean {
		const held = this.passes.get(key);
		const pass = held?.values().next().value;
		if (!held || pass === undefined) return false;
		held.delete(pass);
		return true;
	}

	/**
	 * The checked view of one client object. Every function it holds is
	 * checked by its dotted name, and every object it holds gets a view of its
	 * own, so a sub-client the list has never heard of is still checked.
	 * Methods run on the real object, so `this` holds, a sync method stays
	 * sync, and a method's own inner calls (publishApp calls this.call) are not
	 * checked again.
	 *
	 * @param target - The real client, or an object it holds.
	 * @param prefix - '' for the client, `deploy.` for its `deploy`.
	 * @returns The view.
	 */
	private view(target: object, prefix: string): object {
		const known = this.views.get(target);
		if (known) return known;
		const view = new Proxy(target, {
			get: (real, prop) => {
				const value: unknown = Reflect.get(real, prop, real);
				if (typeof prop !== 'string' || value === (Object.prototype as unknown as Record<string, unknown>)[prop]) return value;
				const name = `${prefix}${prop}`;
				if (typeof value === 'function') {
					return (...params: unknown[]): unknown => {
						this.check(name, params);
						return value.apply(real, params);
					};
				}
				return typeof value === 'object' && value !== null ? this.view(value, `${name}.`) : value;
			},
		});
		this.views.set(target, view);
		return view;
	}

	/**
	 * The backstop, run on every client call a toolkit makes.
	 *
	 * @throws blocked for a never method; afterStop for an ask method once the run is stopped; unannounced for an ask method with no pass.
	 */
	private check(name: string, params: readonly unknown[]): void {
		const rule = rate(name, params, false);
		if (rule === FREE) return;
		if (rule.tier === 'never') throw new Error(blocked(name, rule.why));
		if (this.o.signal.aborted) throw new Error(afterStop(name));
		if (!this.take(passKey(name, params))) throw new Error(unannounced(name));
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The key a pass is kept under. The params are the very values the tool's run
 * passes (rocketride_client applies the same array; publish_app passes the same
 * primitives), so their JSON matches without sorting keys.
 */
function passKey(name: string, params: readonly unknown[]): string {
	return `${name}(${JSON.stringify(params)})`;
}

/** Settles as the card does, or with 'stopped' once the run is stopped, whichever is first. */
function untilStopped(answer: Promise<ChatAskAnswer>, signal: AbortSignal): Promise<ChatAskAnswer> {
	if (signal.aborted) return Promise.resolve('stopped');
	return new Promise((resolve) => {
		const stop = (): void => resolve('stopped');
		signal.addEventListener('abort', stop, { once: true });
		void answer.then((value) => {
			signal.removeEventListener('abort', stop);
			resolve(value);
		});
	});
}
