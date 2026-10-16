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
// PIPELINE RESOLUTION — Settings in, a ready-to-start pipeline out
// =============================================================================
//
// Two substitutions happen here, and one deliberately does NOT.
//
// 1. The Discord id placeholders (`${ROCKETRIDE_DISCORD_GUILD_ID}` and friends)
//    are replaced with the ids from Settings, because they are not secrets and
//    the app, not the server, is where the user typed them. An id left blank
//    drops its array entry rather than sending the literal placeholder, which
//    the node would treat as a real channel id.
//
// 2. The `discord_1` node's behavior and ingestion parameters are overwritten
//    from Settings › Behavior / Advanced, so saving the form really does change
//    what the bot does on the next start.
//
// 3. With the escalation ping on, the prompt components' escalation line gains
//    the team-role mention and the node is allowed to emit that role. With it
//    off, the line stays plain and the node may mention no role at all. The
//    `.pipe` files themselves are never rewritten on disk.
//
// 4. `${ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN}` and `${ROCKETRIDE_OPENAI_KEY}`
//    are left UNTOUCHED. The server resolves those from saved variables
//    (`resolve_pipeline_env`), so the secrets never travel through the browser.
//
// 5. CAPTURE IS ADDED TO THE BOT'S OWN PIPELINE. With `advanced.
//    captureToDatabase` on and a connection in hand, a `capture_db` component
//    is appended and the discord source is pointed at it with `captureEvents`
//    / `captureNodeId`. That is what makes a question asked at 3am reach the
//    dashboard database: the NODE writes it, with no browser open. The
//    component is wired by a control edge FROM the source, because a tool
//    declares its callers on itself. Only the discord node writes; the Slack
//    tool is left exactly as the pipe file has it.
// =============================================================================

import type { PipelineConfig } from 'shell';
import { CAPTURE_NODE_ID, CAPTURE_TABLE, dbComponent, SLACK_PAGING_SUFFIX, type DbConnection } from '../db/config';
import type { BotSettings, PipeChoice } from '../state/types';
import minPipe from '../pipelines/discord-support-min.pipe';
import ragPipe from '../pipelines/discord-support-rag.pipe';
import ralphPipe from '../pipelines/discord-ralph.pipe';
import ralphSlackPipe from '../pipelines/discord-ralph-slack.pipe';
import capturePipe from '../pipelines/discord-eval-capture.pipe';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Placeholders the app substitutes. Everything else stays for the server. */
const GUILD_PLACEHOLDER = '${ROCKETRIDE_DISCORD_GUILD_ID}';
const SUPPORT_PLACEHOLDER = '${ROCKETRIDE_DISCORD_SUPPORT_CHANNEL_ID}';
const MENTION_PLACEHOLDER = '${ROCKETRIDE_DISCORD_MENTION_CHANNEL_ID}';
const ROLE_PLACEHOLDER = '${ROCKETRIDE_DISCORD_TEAM_ROLE_ID}';

/**
 * The escalation line the shipped prompts end an escalating reply with.
 *
 * The prompts are the app's own files, so this literal is a contract between
 * them and this module — the same line `outcomeOfReply` recognises, and the
 * default entry in Settings › Behavior › Escalation Markers.
 */
export const ESCALATION_LINE = 'Escalated to the RocketRide team.';

/** Human labels for the pipe choices, used by Settings › Pipeline. */
export const PIPE_LABELS: Record<PipeChoice, string> = {
	min: 'Support (minimal)',
	rag: 'Support with docs retrieval',
	ralph: 'Support with RAG and tools',
	ralphSlack: 'Support with RAG, tools and Slack paging',
};

/** What each pipe is, in one line, for Settings › Pipeline. */
export const PIPE_DESCRIPTIONS: Record<PipeChoice, string> = {
	min: 'Discord to prompt to OpenAI to reply. Fewest moving parts — start here.',
	rag: 'Retrieves passages from the RocketRide docs (Chroma, collection ROCKETRIDE_DOCS on localhost:8000) before the prompt reaches OpenAI. Needs the docs ingested first.',
	ralph: 'Adds retrieval over the docs collection, the CrewAI agent and its tools.',
	ralphSlack: 'The agent pipe plus a Slack tool: the first escalation in a thread posts a one-line summary to the Slack incoming webhook named by the Slack setting.',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Deep-clone a pipeline so a resolution never mutates the imported module.
 *
 * @param value - The parsed `.pipe` object.
 * @returns An independent copy.
 */
function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Replace the id placeholders in every string of a JSON tree.
 *
 * Array entries that resolve to an empty string are dropped: an empty
 * `channelIds` entry would otherwise be a channel id the node can never match,
 * while an absent entry means "listen everywhere", which is the node's
 * documented behavior for an empty list.
 *
 * @param value - Any JSON value from the pipeline.
 * @param ids - The replacement map, placeholder to id.
 * @returns The value with placeholders substituted.
 */
function substitute(value: unknown, ids: Record<string, string>): unknown {
	if (typeof value === 'string') {
		let out = value;
		for (const [placeholder, id] of Object.entries(ids)) {
			if (out.includes(placeholder)) out = out.split(placeholder).join(id);
		}
		return out;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => substitute(entry, ids)).filter((entry) => entry !== '');
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = substitute(entry, ids);
		}
		return out;
	}
	return value;
}

/**
 * The `discord.*` parameters Settings owns, in the flat shape the engine
 * delivers (the `discord.` prefix is stripped before the node sees them).
 *
 * @param settings - The saved settings form.
 * @returns Parameters to overlay on the source component's config.
 */
function discordParameters(settings: BotSettings): Record<string, unknown> {
	const { behavior, advanced } = settings;
	return {
		replyMode: behavior.replyMode,
		threadName: behavior.threadName,
		threadNameMaxLength: behavior.threadNameMaxLength,
		threadAutoArchiveMinutes: behavior.threadAutoArchiveMinutes,
		showTyping: behavior.showTyping,
		ignoreBots: behavior.ignoreBots,
		// The five opt-in behaviors the original support bot ran. Note that
		// `behavior.pingTeamOnEscalation` is NOT here: it is not a node parameter
		// but a rewrite of the prompt plus `allowedMentionRoleIds`, both below.
		threadHistoryLimit: behavior.threadHistoryLimit,
		threadHistoryMaxChars: behavior.threadHistoryMaxChars,
		escalationPause: behavior.escalationPause,
		escalationMarkers: behavior.escalationMarkers,
		ignoreAimedAtOthers: behavior.ignoreAimedAtOthers,
		ackEmoji: behavior.ackEmoji,
		feedbackReactions: behavior.feedbackReactions,
		feedbackEmojis: behavior.feedbackEmojis,
		sanitizeReplies: behavior.sanitizeReplies,
		backfillLimit: advanced.backfillLimit,
		maxAttachmentBytes: advanced.maxAttachmentBytes,
		textAttachmentExtensions: advanced.textAttachmentExtensions,
		textAttachmentMaxChars: advanced.textAttachmentMaxChars,
		// Opt-in on the node; Ralph always answered a message with files once.
		mergeAttachments: true,
		emitReactions: advanced.emitReactions,
		emitNoReply: advanced.emitNoReply,
		emitOutbound: advanced.emitOutbound,
		includeMemberMetadata: advanced.includeMemberMetadata,
		allowedBotIds: settings.discord.allowedBotIds,
	};
}

/**
 * Make the prompts' escalation line end with a ping of the team role.
 *
 * The prompt instruction the shipped pipes carry ends an escalating reply with
 * {@link ESCALATION_LINE}, which reads as an escalation to a human and pings
 * nobody. Turning Settings › Behavior › Ping The Team On Escalation on appends
 * the role mention to that ONE line, in place, so the reply the model writes
 * ends with `<@&…>` and the node (whose `allowedMentionRoleIds` is set to the
 * same role below) lets it through.
 *
 * The `.pipe` files are not edited for this: an app that rewrote its own source
 * files would put the switch's state in two places, and the setting is the one
 * that has to win.
 *
 * @param components - The resolved pipeline's components, mutated in place.
 * @param roleId - The team role id. Empty does nothing: a mention of no role is
 *        a literal `<@&>` in the answer.
 */
function pingTeamInPrompts(components: Record<string, unknown>[], roleId: string): void {
	if (roleId.length === 0) return;
	for (const component of components) {
		if (component.provider !== 'prompt') continue;
		const config = component.config as Record<string, unknown> | undefined;
		if (!config) continue;
		const instructions = config.instructions;
		if (!Array.isArray(instructions)) continue;
		config.instructions = instructions.map((line) => (typeof line === 'string' && line.includes(ESCALATION_LINE) ? line.split(ESCALATION_LINE).join(`${ESCALATION_LINE} <@&${roleId}>`) : line));
	}
}

// =============================================================================
// API
// =============================================================================

/** The pipes the app ships, by choice id. */
export const PIPELINES: Record<PipeChoice, Record<string, unknown>> = {
	min: minPipe,
	rag: ragPipe,
	ralph: ralphPipe,
	ralphSlack: ralphSlackPipe,
};

/** The shadow capture pipe — started as its own task when capture is on. */
export const CAPTURE_PIPELINE: Record<string, unknown> = capturePipe;

/** How a resolution may differ from the plain one. */
export interface ResolveOptions {
	/**
	 * Overlay Settings onto the `discord` source's parameters.
	 *
	 * False for the capture pipe, whose emit flags and `sendResponses: false`
	 * are what make it a shadow branch.
	 */
	applyNodeConfig?: boolean;
	/**
	 * Where the dashboard database is.
	 *
	 * Omitted means NO capture component, whatever the setting says — which is
	 * what a replay copy resolves with, and what every caller that has no
	 * connection in hand gets.
	 */
	conn?: DbConnection;
}

/**
 * Add the capture component and point the discord source at it.
 *
 * The source writes `message`, `outbound`, `no_reply` and `reaction` rows,
 * opt-in on the node (`captureEvents`), through the component named by
 * `captureNodeId`. Its keys live under `config.parameters` (the engine strips
 * the `discord.` prefix).
 *
 * A SLACK PAGE IS NOT A ROW. The engine never reports what a tool did, and
 * the Slack tool is a shared node this app does not change. Instead every row
 * carries a `captureSource` label, and on a pipe with a `tool_slack` the label
 * ends in {@link SLACK_PAGING_SUFFIX}. The pipe's prompt pages Slack on the
 * first escalation in a thread, so the fold reads "first escalation reply in
 * a thread, written by a paging pipe" as "a page was triggered". Whether
 * Slack accepted the post is not known to the engine, and so not to the app.
 *
 * @param components - The resolved pipeline's components. Appended to in place.
 * @param conn - Where the database is.
 * @param source - The `discord` source component, or undefined when the pipe
 *        has none (nothing to capture from, so nothing is added).
 */
function addCapture(components: Record<string, unknown>[], conn: DbConnection, source: Record<string, unknown> | undefined): void {
	if (source === undefined) return;
	const sourceId = String(source.id ?? '');
	if (sourceId.length === 0) return;

	const pagesSlack = components.some((component) => component.provider === 'tool_slack');
	const captureSource = `discord:${sourceId}${pagesSlack ? SLACK_PAGING_SUFFIX : ''}`;

	// The source's own capture keys ride with the rest of its parameters, which
	// the caller writes just below; they are set here so the two cannot be
	// applied in the wrong order.
	const config = (source.config ?? {}) as Record<string, unknown>;
	const parameters = (config.parameters ?? {}) as Record<string, unknown>;
	source.config = {
		...config,
		parameters: { ...parameters, captureEvents: true, captureNodeId: CAPTURE_NODE_ID, captureTable: CAPTURE_TABLE, captureSource },
	};

	components.push(dbComponent(CAPTURE_NODE_ID, conn, [{ classType: 'tool', from: sourceId }]));
}

/**
 * Resolve a pipeline for `client.use()`.
 *
 * @param raw - One of {@link PIPELINES} or {@link CAPTURE_PIPELINE}.
 * @param settings - The saved settings form.
 * @param options - See {@link ResolveOptions}.
 * @returns A pipeline ready to start, with the secrets still as placeholders.
 */
export function resolvePipeline(raw: Record<string, unknown>, settings: BotSettings, options: ResolveOptions = {}): PipelineConfig {
	const { discord } = settings;
	const ids: Record<string, string> = {
		[GUILD_PLACEHOLDER]: discord.guildId.trim(),
		[SUPPORT_PLACEHOLDER]: discord.supportChannelIds[0]?.trim() ?? '',
		[MENTION_PLACEHOLDER]: discord.mentionChannelIds[0]?.trim() ?? '',
		[ROLE_PLACEHOLDER]: discord.teamRoleId.trim(),
	};

	const resolved = substitute(clone(raw), ids) as PipelineConfig & {
		components?: Record<string, unknown>[];
	};

	// The escalation ping is one switch over two places: the prompt line the model
	// writes, and the role mentions the node is willing to let out. Both are off
	// unless Settings › Behavior asks for the ping, so a test round escalates in
	// words without notifying anybody.
	const roleId = discord.teamRoleId.trim();
	const pingTeam = settings.behavior.pingTeamOnEscalation && roleId.length > 0;
	if (pingTeam) pingTeamInPrompts(resolved.components ?? [], roleId);

	const source = resolved.components?.find((c) => c.provider === 'discord');

	// Capture FIRST, so the keys it writes onto the source are part of the
	// `parameters` the block below spreads rather than a second write that
	// could be overwritten by it.
	if (options.conn !== undefined && settings.advanced.captureToDatabase) {
		// Cast for the same reason the block below casts `source.config`: the
		// shell's `PipelineComponent` is a named shape without an index
		// signature, and a resolved pipeline is plain JSON.
		addCapture((resolved.components ?? []) as Record<string, unknown>[], options.conn, source as Record<string, unknown> | undefined);
	}

	if (source) {
		const config = (source.config ?? {}) as Record<string, unknown>;
		const parameters = (config.parameters ?? {}) as Record<string, unknown>;
		// Every id list comes from Settings, so the full lists survive — the
		// placeholder substitution above only ever carries the FIRST id.
		const fromSettings: Record<string, unknown> = {
			guildIds: discord.guildId.trim() ? [discord.guildId.trim()] : [],
			channelIds: discord.supportChannelIds.filter((id) => id.trim()),
			requireMentionChannelIds: discord.mentionChannelIds.filter((id) => id.trim()),
			allowedMentionRoleIds: pingTeam ? [roleId] : [],
		};
		source.config = {
			...config,
			parameters: {
				...parameters,
				...fromSettings,
				...(options.applyNodeConfig === false ? {} : discordParameters(settings)),
			},
		};
	}

	return resolved;
}

/**
 * The identity the server keys a running task on.
 *
 * `getTaskToken`, `restart` and the monitor subscription all address a task by
 * `(projectId, source)` rather than by token, so a reload that lost the token
 * can still find the task the previous session started.
 */
export interface PipeIdentity {
	/** The pipe's `project_id`. */
	projectId: string;
	/** The id of the pipe's source component. */
	source: string;
}

/**
 * Read a pipe's task identity out of the pipeline document.
 *
 * `source` is the explicit top-level field when the pipe has several starts
 * (the RAG pipe), and otherwise the one source component's id.
 *
 * @param raw - One of {@link PIPELINES} or {@link CAPTURE_PIPELINE}.
 * @returns The project id and source component id.
 */
export function pipeIdentity(raw: Record<string, unknown>): PipeIdentity {
	const components = (raw.components ?? []) as Record<string, unknown>[];
	const declared = typeof raw.source === 'string' ? raw.source : '';
	const discord = components.find((c) => c.provider === 'discord');
	return {
		projectId: String(raw.project_id ?? ''),
		source: declared || String(discord?.id ?? ''),
	};
}

/**
 * The optional server variables a start checks, and what the server holds.
 *
 * Only the RAG pipe references `ROCKETRIDE_GITHUB_TOKEN` (its agent's tools)
 * and only the capture pipe references `ROCKETRIDE_QDRANT_HOST` (its store), so
 * neither is a precondition for the minimal pipe. Both are declared as
 * `rocketride.envkey` settings, which is why the NAMES arrive as parameters
 * rather than being hardcoded here.
 */
export interface OptionalVariables {
	/** The name the `githubToken` setting holds. */
	github: string;
	/** The name the `qdrantHost` setting holds. */
	qdrant: string;
	/** The name the `slackWebhook` setting holds (the Slack-paging pipe only). */
	slack?: string;
	/** Names saved on the server, or null when the list could not be read. */
	saved: string[] | null;
}

/**
 * Whether the settings carry the ids and variables a start needs.
 *
 * @param settings - The saved settings form.
 * @param variables - The optional variables and what the server holds. Omitted
 *        (or with an unknown `saved` list) checks the ids only: an unreadable
 *        account surface must not masquerade as a missing variable.
 * @returns The missing labels; empty when the bot can start.
 */
export function missingForStart(settings: BotSettings, variables?: OptionalVariables): string[] {
	const missing: string[] = [];
	if (!settings.discord.guildId.trim()) missing.push('Server ID');
	if (settings.discord.supportChannelIds.filter((id) => id.trim()).length === 0) {
		missing.push('Support channel ID');
	}
	const saved = variables?.saved ?? null;
	if (variables === undefined || saved === null) return missing;
	const agentPipe = settings.pipeline.pipe === 'ralph' || settings.pipeline.pipe === 'ralphSlack';
	if (agentPipe && variables.github.length > 0 && !saved.includes(variables.github)) {
		missing.push(`the ${variables.github} server variable, which the RAG pipe needs`);
	}
	const slack = variables.slack ?? '';
	if (settings.pipeline.pipe === 'ralphSlack' && slack.length > 0 && !saved.includes(slack)) {
		missing.push(`the ${slack} server variable, which the Slack-paging pipe needs`);
	}
	if (settings.pipeline.captureEnabled && variables.qdrant.length > 0 && !saved.includes(variables.qdrant)) {
		missing.push(`the ${variables.qdrant} server variable, which the capture pipe needs`);
	}
	return missing;
}
