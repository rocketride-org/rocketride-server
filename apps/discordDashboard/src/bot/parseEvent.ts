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
// EVENT PARSING — the node's SSE events in, conversation rows out
// =============================================================================
//
// The `discord` node broadcasts every object it opens as a real-time SSE
// event (`IEndpoint.py::_send_sse` → `monitorSSE`), which reaches the browser
// as the DAP event `apaevt_sse`:
//
//   { event: 'apaevt_sse', body: { pipe_id, type: 'discord', data: {…} } }
//
// and `data` is the node's own contract, not an engine wrapper:
//
//   { schemaVersion: 1, eventType, metadata: {…}, ...payload }
//
// This is the ONLY channel that carries the node's metadata to a subscriber:
// the node attaches it with `sendTagMetadata` and writes its event JSON on the
// tags lane, and pipeline traces serialize neither — which is why the app
// subscribes `SSE` rather than mining `apaevt_flow` bodies (a fixed path in a
// documented contract, not a search through an engine-internal shape).
//
// Payloads, by `eventType` (`nodes/src/nodes/discord/README.md`):
//   message   { lane: 'text', text } | { lane: 'binary', mimeType, size }
//   outbound  { messageIds, destination: reply|channel|thread|suppressed, text }
//   no_reply  { reason }
//   reaction  { emoji, added, userId }
// =============================================================================

import type { Outcome } from '../state/types';

// =============================================================================
// TYPES
// =============================================================================

/** One decoded `discord` node event. */
export interface DiscordEvent {
	/** The node's `eventType`: message, outbound, no_reply or reaction. */
	eventType: string;
	/** `metadata.messageId` — the conversation row identity. */
	messageId: string;
	/** `metadata.channelId`. */
	channelId: string;
	/** `metadata.guildId`, when the message came from a server. */
	guildId: string | null;
	/** `metadata.threadId`, when the message arrived in a thread. */
	threadId: string | null;
	/** `metadata.authorId`. */
	authorId: string;
	/** `metadata.authorIsBot` — true for a bot the ignore-bots gate let through. */
	authorIsBot: boolean;
	/** `metadata.authorDisplayName`, when member metadata is on. */
	authorName: string | null;
	/** `metadata.authorRoleIds`, when member metadata is on. */
	authorRoleIds: string[];
	/**
	 * `metadata.mentionedUserIds` — who this message @mentions.
	 *
	 * The eval capture needs it for one distinction the reference bot made: a
	 * team member's message that mentions the bot is a `team_mention` (they are
	 * talking TO the bot) rather than a `team_reply` (they are answering the
	 * asker themselves).
	 */
	mentionedUserIds: string[];
	/** `metadata.botUserId` — the bot's own user id, as the node sees it. */
	botUserId: string | null;
	/** `metadata.correlationId` — shared by every object from one message. */
	correlationId: string;
	/**
	 * `metadata.createdAt`, as Unix ms — when DISCORD stamped the message, which
	 * is what the event log is ordered by. Null when the node did not send it.
	 */
	createdAt: number | null;
	/** `metadata.attachments`. */
	attachments: { name: string | null; size: number | null }[];
	/** The question text, on a `message` event that carried the text lane. */
	text: string | null;
	/** The answer text, on an `outbound` event. */
	replyText: string | null;
	/**
	 * The ids of the messages the bot posted, on an `outbound` event.
	 *
	 * These are what a later `reaction` event is keyed on: a reader reacts to
	 * the bot's ANSWER, so the reaction's `messageId` is one of these and not
	 * the question's.
	 */
	messageIds: string[];
	/** Where the answer went, on an `outbound` event. */
	destination: string | null;
	/** The node's reason string, on a `no_reply` event. */
	reason: string | null;
	/** The emoji, on a `reaction` event. */
	emoji: string | null;
	/** Whether the reaction was added (false = removed). */
	reactionAdded: boolean;
	/** `userId` — who reacted, on a `reaction` event. */
	reactionUserId: string | null;
	/**
	 * The `retry` ordinal, on a `message` event that is a retried text pass.
	 *
	 * The node re-runs the identical text under `<messageId>:retry1` when the
	 * first pass answered with nothing but scratchpad (`nonAnswerRetries`); the
	 * original run carries no `retry` key. Null on every other event.
	 */
	retry: number | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The DAP event the engine forwards `monitorSSE` calls on. */
export const SSE_EVENT_NAME = 'apaevt_sse';

/** The `type` the `discord` node broadcasts under. Other types are not ours. */
export const DISCORD_SSE_TYPE = 'discord';

/** The node's own event types. Anything else is a contract the app postdates. */
const EVENT_TYPES = new Set(['message', 'outbound', 'no_reply', 'reaction']);

/**
 * The reasons the node emits when a turn genuinely produced no answer. Any
 * other reason string is an exception message, i.e. an error outcome.
 *
 * `IEndpoint.py::_process_message` — `'no_answer'` when the pipeline returned
 * nothing, `'non_answer'` when `sanitizeReplies` judged the text not to be an
 * answer and dropped it, otherwise the caught exception's text. Both are the
 * bot failing to answer a question it accepted, so both need a human.
 */
const SILENT_REASONS = new Set(['no_answer', 'non_answer']);

/**
 * The reasons that are a DELIBERATE silence rather than a missed question.
 *
 * `paused` is `escalationPause`: the thread has already been handed to the team
 * and the bot stays out of it until it is @mentioned again. `aimed_elsewhere`
 * is `ignoreAimedAtOthers`: the message mentioned someone else or replied to a
 * non-bot message, so it was never the bot's turn. Neither is anybody's to do.
 */
const QUIET_REASONS = new Set(['paused', 'aimed_elsewhere']);

// =============================================================================
// HELPERS
// =============================================================================

/** Narrow an unknown to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a string field, or null when it is absent, empty or not a string. */
function str(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read a string array field, dropping anything that is not a string. */
function strList(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Read the node's attachment descriptors, tolerating a partial shape.
 *
 * @param record - The metadata record.
 * @returns Attachment names and sizes; empty when the field is absent.
 */
/**
 * Read an ISO timestamp field as Unix ms.
 *
 * @param record - The metadata record.
 * @param key - The field name.
 * @returns The stamp, or null when absent or unparseable.
 */
function stamp(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function attachmentList(record: Record<string, unknown>): { name: string | null; size: number | null }[] {
	const value = record.attachments;
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).map((entry) => ({
		name: typeof entry.name === 'string' ? entry.name : null,
		size: typeof entry.size === 'number' ? entry.size : null,
	}));
}

// =============================================================================
// API
// =============================================================================

/**
 * Decode one `apaevt_sse` body into a {@link DiscordEvent}.
 *
 * @param body - The DAP event's `body`: `{ pipe_id, type, data }`.
 * @returns The decoded event, or null when the event is not one of ours.
 */
export function parseDiscordEvent(body: unknown): DiscordEvent | null {
	if (!isRecord(body)) return null;
	// Other nodes broadcast on the same channel ("thinking", "tool_call", …).
	if (body.type !== DISCORD_SSE_TYPE) return null;

	const data = body.data;
	if (!isRecord(data)) return null;

	const eventType = typeof data.eventType === 'string' ? data.eventType : '';
	if (!EVENT_TYPES.has(eventType)) return null;

	const metadata = isRecord(data.metadata) ? data.metadata : null;
	if (!metadata) return null;

	// messageId plus channelId is the row identity; without both there is no
	// conversation to fold the event into.
	const messageId = str(metadata, 'messageId');
	const channelId = str(metadata, 'channelId');
	if (!messageId || !channelId) return null;

	// On a `message` event the payload's `text` is the question, and only on the
	// text lane — a binary lane object carries mimeType and size instead. On an
	// `outbound` event the same key is the node's own answer.
	const payloadText = typeof data.text === 'string' ? data.text : null;
	const isTextLane = data.lane === 'text';

	return {
		eventType,
		messageId,
		channelId,
		guildId: str(metadata, 'guildId'),
		threadId: str(metadata, 'threadId'),
		authorId: str(metadata, 'authorId') ?? '',
		authorIsBot: metadata.authorIsBot === true,
		authorName: str(metadata, 'authorDisplayName'),
		authorRoleIds: strList(metadata, 'authorRoleIds'),
		mentionedUserIds: strList(metadata, 'mentionedUserIds'),
		botUserId: str(metadata, 'botUserId'),
		correlationId: str(metadata, 'correlationId') ?? messageId,
		createdAt: stamp(metadata, 'createdAt'),
		attachments: attachmentList(metadata),
		text: eventType === 'message' && isTextLane ? payloadText : null,
		replyText: eventType === 'outbound' ? payloadText : null,
		messageIds: eventType === 'outbound' ? strList(data, 'messageIds') : [],
		destination: eventType === 'outbound' ? str(data, 'destination') : null,
		reason: eventType === 'no_reply' ? str(data, 'reason') : null,
		emoji: eventType === 'reaction' ? str(data, 'emoji') : null,
		reactionAdded: data.added !== false,
		reactionUserId: eventType === 'reaction' ? str(data, 'userId') : null,
		retry: eventType === 'message' && typeof data.retry === 'number' ? data.retry : null,
	};
}

/**
 * The SSE broadcast the agent node makes when it starts a tool call.
 *
 * Agent nodes share the `apaevt_sse` channel with the discord node and emit
 * `thinking` events; the one that matters here is "Calling <tool>...", because
 * a Slack page is the only side effect of an answer that the answer text does
 * not show. The tool name is CrewAI's flattened form of the host catalog id
 * (`tool_slack_1.message_post` becomes `tool_slack_1_message_post`).
 */
const TOOL_CALL_PREFIX = 'Calling ';

/**
 * The tool an agent `thinking` broadcast says it is calling, if that is what
 * the broadcast is.
 *
 * @param body - The `apaevt_sse` event body.
 * @returns The tool name (e.g. `tool_slack_1_message_post`), or null when the
 *   body is not a tool-call broadcast.
 */
export function parseToolCallEvent(body: unknown): string | null {
	if (!isRecord(body) || body.type !== 'thinking') return null;
	const data = body.data;
	if (!isRecord(data) || typeof data.message !== 'string') return null;
	if (!data.message.startsWith(TOOL_CALL_PREFIX)) return null;
	const name = data.message
		.slice(TOOL_CALL_PREFIX.length)
		.replace(/\.{3}$/, '')
		.trim();
	return name.length > 0 ? name : null;
}

/**
 * Whether a tool name is the Slack tool's message post.
 *
 * Any Slack component id is accepted (`tool_slack_1`, `tool_slack_2`, …) so a
 * pipe edited in the builder keeps the marker.
 *
 * @param tool - A name from {@link parseToolCallEvent}.
 * @returns True for a Slack message post.
 */
export function isSlackPage(tool: string): boolean {
	return /^tool_slack(?:_\d+)?[._]message_post$/.test(tool);
}

/**
 * The outcome an `outbound` event implies.
 *
 * A reply carrying a role mention (`<@&…>`) is the escalation: the node only
 * lets through the role ids in `allowedMentionRoleIds`, so the literal in the
 * answer IS the team ping (UX spec feature 4). A pipeline configured not to
 * ping (test rounds, quiet hours) ends the reply with the plain line
 * "Escalated to the RocketRide team." instead, which counts the same way.
 *
 * @param replyText - The answer the node posted.
 * @returns `escalated` when the answer pings or names the team, else `answered`.
 */
export function outcomeOfReply(replyText: string | null): Outcome {
	if (replyText === null) return 'answered';
	if (replyText.includes('<@&')) return 'escalated';
	return /escalated to the rocketride team/i.test(replyText) ? 'escalated' : 'answered';
}

/**
 * The outcome a `no_reply` event implies.
 *
 * @param reason - The node's reason string.
 * @returns `quiet` when the node chose to stay out of it, `no_reply` when a
 *          question went unanswered, `error` for a failure.
 */
export function outcomeOfNoReply(reason: string | null): Outcome {
	if (reason === null || SILENT_REASONS.has(reason)) return 'no_reply';
	if (QUIET_REASONS.has(reason)) return 'quiet';
	return 'error';
}
