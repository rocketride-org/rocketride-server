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
// SETTINGS › BEHAVIOR — how the bot answers
// =============================================================================
//
// Field titles, enums and defaults are the ones in
// `nodes/src/nodes/discord/services.json`, and each help line names the
// `discord.*` key it writes.
//
// The departures are deliberate and are the app's whole point: this app runs the
// ORIGINAL RocketRide support bot, and the node ships the behaviors that bot had
// as opt-in flags. So Reply Mode defaults to `thread` (the node says `reply`),
// and the five groups below — thread history, the escalation pause, the 👀 on
// messages aimed at someone else, and reply hygiene — arrive switched ON with
// the numbers that bot ran. Every one of them can be turned off here.
// =============================================================================

import React from 'react';
import { Section } from 'shell';
import type { BehaviorSettings, ReplyMode } from '../../state/types';

import { BooleanField, IdListField, NumberField, SelectField, TextField, TextListField } from './fields';

// =============================================================================
// CONSTANTS
// =============================================================================

/** `discord.replyMode`'s enum, with what each choice means in practice. */
const REPLY_MODES: { value: ReplyMode; label: string }[] = [
	{ value: 'thread', label: 'Thread — one thread per question' },
	{ value: 'reply', label: 'Reply — answer as a reply in the channel' },
	{ value: 'channel', label: 'Channel — post as a normal message' },
];

// =============================================================================
// GROUP
// =============================================================================

/**
 * One titled group of fields.
 *
 * The page carries fourteen controls, which is a wall without headings. The
 * shell's `Section` gives the same uppercase label and divider the detail panels
 * use; the inner stack is what keeps the form's own rhythm inside it.
 *
 * @param props.label - The group heading.
 * @param props.children - Its fields.
 * @returns The group.
 */
const Group: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
	<Section label={label}>
		<div className="dd-form">{children}</div>
	</Section>
);

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link BehaviorPage}. */
export interface BehaviorPageProps {
	/** The draft being edited. */
	value: BehaviorSettings;
	/** Merge a patch into the draft. */
	onChange: (patch: Partial<BehaviorSettings>) => void;
	/** Read-only mode (sample data on, or a save in flight). */
	disabled: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Settings › Behavior.
 *
 * @param props - See {@link BehaviorPageProps}.
 * @returns The form.
 */
export const BehaviorPage: React.FC<BehaviorPageProps> = ({ value, onChange, disabled }) => (
	<div className="dd-form">
		<SelectField<ReplyMode> label="Reply Mode" help="How the bot sends answers. Thread keeps one question per thread and is what the support pipes assume. Writes discord.replyMode." value={value.replyMode} options={REPLY_MODES} disabled={disabled} onChange={(replyMode) => onChange({ replyMode })} />

		<TextField label="Thread Name" help="Name template for answer threads. {content} is replaced with the question text. Writes discord.threadName." value={value.threadName} disabled={disabled} onChange={(threadName) => onChange({ threadName })} />

		<NumberField label="Thread Name Max Length" help="Longest resolved thread name, in characters. Node default 90. Writes discord.threadNameMaxLength." value={value.threadNameMaxLength} min={1} disabled={disabled} onChange={(threadNameMaxLength) => onChange({ threadNameMaxLength })} />

		<NumberField label="Thread Auto Archive Minutes" help="Discord auto-archive duration for new threads. Node default 1440 (one day). Writes discord.threadAutoArchiveMinutes." value={value.threadAutoArchiveMinutes} min={1} disabled={disabled} onChange={(threadAutoArchiveMinutes) => onChange({ threadAutoArchiveMinutes })} />

		<BooleanField label="Show Typing Indicator" help="Show Discord's typing indicator while the pipeline is working. Writes discord.showTyping." value={value.showTyping} disabled={disabled} onChange={(showTyping) => onChange({ showTyping })} />

		<BooleanField label="Ignore Bot Messages" help="Skip messages from other bots, which is what stops answer loops. The bot never processes its own messages either way. Writes discord.ignoreBots." value={value.ignoreBots} disabled={disabled} onChange={(ignoreBots) => onChange({ ignoreBots })} />

		<p className="dd-help dd-form__note">Answers longer than Discord&rsquo;s 2000-character limit are split by the node on sentence and line boundaries, with code fences reopened — there is nothing to configure for that.</p>

		{/* --- Thread context ---------------------------------------------- */}
		<Group label="Thread context">
			<NumberField label="Thread History Limit" help="Messages of the thread's own history to prepend as context on a follow-up. The original support bot read the last 50; 0 turns thread context off, which is the node default and makes every message a cold start. At most 100. Writes discord.threadHistoryLimit." max={100} value={value.threadHistoryLimit} disabled={disabled} onChange={(threadHistoryLimit) => onChange({ threadHistoryLimit })} />

			<NumberField label="Thread History Max Characters" help="Cap on that transcript, so a long thread cannot crowd the question out of the prompt. Node default 6000, at most 20000. Writes discord.threadHistoryMaxChars." max={20000} value={value.threadHistoryMaxChars} disabled={disabled} onChange={(threadHistoryMaxChars) => onChange({ threadHistoryMaxChars })} />
		</Group>

		{/* --- Escalation --------------------------------------------------- */}
		<Group label="Escalation">
			<BooleanField label="Pause After Escalation" help="Once the bot has escalated in a thread, it stays quiet there until someone @mentions it again — the original bot's rule, so the team owns a thread it has been handed. Writes discord.escalationPause." value={value.escalationPause} disabled={disabled} onChange={(escalationPause) => onChange({ escalationPause })} />

			<TextListField label="Escalation Markers" help="Reply text that counts as an escalation, one phrase per line. Every role mention the bot is allowed to make counts automatically, so this is for the wording used when it pings nobody. Writes discord.escalationMarkers." placeholder="Escalated to the RocketRide team." value={value.escalationMarkers} disabled={disabled} onChange={(escalationMarkers) => onChange({ escalationMarkers })} />

			<BooleanField label="Ping The Team On Escalation" help="Make an escalating reply end with a mention of the team role from Settings › Discord, and allow the bot to emit that mention. Off — the default — keeps the plain escalation line and lets the bot mention no role at all, which is what you want for test rounds. This one rewrites the prompt and discord.allowedMentionRoleIds rather than writing a node parameter of its own." value={value.pingTeamOnEscalation} disabled={disabled} onChange={(pingTeamOnEscalation) => onChange({ pingTeamOnEscalation })} />
		</Group>

		{/* --- Aimed at someone else ---------------------------------------- */}
		<Group label="Aimed at someone else">
			<BooleanField label="Ignore Messages Aimed At Others" help="A message that @mentions somebody else, or replies to a message that is not the bot's, is not answered — the original bot stayed out of conversations that were not with it. Writes discord.ignoreAimedAtOthers." value={value.ignoreAimedAtOthers} disabled={disabled} onChange={(ignoreAimedAtOthers) => onChange({ ignoreAimedAtOthers })} />

			<TextField label="Acknowledgement Emoji" help="The reaction the bot adds to such a message instead of answering — the original bot used 👀, so the asker can see it was read. Empty adds nothing. Writes discord.ackEmoji." placeholder="👀" value={value.ackEmoji} disabled={disabled} onChange={(ackEmoji) => onChange({ ackEmoji })} />
		</Group>

		{/* --- Feedback reactions ------------------------------------------- */}
		<Group label="Feedback reactions">
			<BooleanField label="Add Feedback Reactions" help="Add the emoji below to the last chunk of every answer, as the original bot's thumbs-up / thumbs-down signal for the eval loop. Off by default: it asks every reader for a verdict, and the Reactions column captures what they add unprompted either way. Writes discord.feedbackReactions." value={value.feedbackReactions} disabled={disabled} onChange={(feedbackReactions) => onChange({ feedbackReactions })} />

			<IdListField label="Feedback Emojis" help="The emoji it adds, comma separated. Node default ✅, ❌ — the pair the eval loop reads back. Writes discord.feedbackEmojis." placeholder="✅, ❌" value={value.feedbackEmojis} disabled={disabled} onChange={(feedbackEmojis) => onChange({ feedbackEmojis })} />
		</Group>

		{/* --- Reply hygiene ------------------------------------------------ */}
		<Group label="Reply hygiene">
			<BooleanField label="Sanitize Replies" help="Strip the model's reasoning scaffolding (“Thought:”, “Final Answer:” and the like) before posting, and post nothing at all when what is left is not an answer — the original bot never let its own thinking reach the channel. A suppressed reply shows up as No reply with the reason non_answer. Writes discord.sanitizeReplies." value={value.sanitizeReplies} disabled={disabled} onChange={(sanitizeReplies) => onChange({ sanitizeReplies })} />
		</Group>
	</div>
);
