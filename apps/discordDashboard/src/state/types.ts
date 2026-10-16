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
// APP DATA — the shape every screen reads, and the UI prefs the shell persists
// =============================================================================
//
// {@link AppData} is no longer a persisted blob. Settings, conversations,
// grades, reviews, clusters, golden cases, replay runs and the Teach Ralph
// records live in a shared Postgres database (`src/db/`), and
// `useDashboardData` assembles this shape out of it on every load. The type
// survives unchanged because it is the contract the screens render from.
//
// The workspace slice keeps ONE thing: the per-viewer UI preferences under
// {@link UI_STATE_KEY} ({@link UiPrefs}, version 2). The version-1 slice under
// {@link APP_STATE_KEY} is left on disk and ignored — it is what the one-off
// import script reads.
//
// Secrets never enter this file. The bot token, the OpenAI key and the
// database password are held as server variables and referenced by NAME
// through the shell's settings registry (`contributes.configuration`, format
// `rocketride.envkey`).
// =============================================================================

import type { EvalCause, EvalEvent, EvalOutcome, RalphReplyType } from '../eval/rules';

/**
 * Workspace-state key the VERSION-1 slice was written under.
 *
 * Nothing reads it any more. It is kept named because the orchestrator's
 * import script finds the old data by this key, and deleting the slice is not
 * this app's call.
 */
export const APP_STATE_KEY = 'mithilesh_clock.discordDashboard';

/** Workspace-state key holding the version-2 UI preferences. */
export const UI_STATE_KEY = 'mithilesh_clock.discordDashboard.ui';

/** Shell settings key naming the variable that holds the Discord bot token. */
export const BOT_TOKEN_SETTING = 'mithilesh_clock.discordDashboard.botToken';

/** Shell settings key naming the variable that holds the OpenAI key. */
export const OPENAI_KEY_SETTING = 'mithilesh_clock.discordDashboard.openaiKey';

/**
 * Shell settings key naming the variable that holds the GitHub token.
 *
 * Optional: only the RAG pipe's agent tools reference it
 * (`discord-ralph.pipe`), so it is a precondition for that pipe alone.
 */
export const GITHUB_TOKEN_SETTING = 'mithilesh_clock.discordDashboard.githubToken';

/**
 * Shell settings key naming the variable that holds the Qdrant host.
 *
 * Optional: only the eval-capture pipe's store references it
 * (`discord-eval-capture.pipe`), so it is a precondition for that pipe alone.
 */
export const QDRANT_HOST_SETTING = 'mithilesh_clock.discordDashboard.qdrantHost';

/**
 * Shell settings key naming the variable that holds the Slack incoming-webhook
 * URL the agent pages on the first escalation in a thread.
 *
 * Optional: only the Slack-paging pipe (`discord-ralph-slack.pipe`) references
 * it, so it is a precondition for that pipe alone. Point it at a TEST webhook
 * while testing.
 */
export const SLACK_WEBHOOK_SETTING = 'mithilesh_clock.discordDashboard.slackWebhook';

// --- The dashboard database -------------------------------------------------
//
// The connection lives in the MANIFEST, not in the database: the app has to
// know where the database is before it can read anything out of it, and a
// connection stored in the thing it connects to is a chicken-and-egg. These
// five are the only app configuration that is not a `dd_settings` row.

/** Shell settings key naming the database node: `db_postgres` or `rocketride_sql`. */
export const DB_PROVIDER_SETTING = 'mithilesh_clock.discordDashboard.dbProvider';

/** Shell settings key holding `host:port` — `db_postgres` only. */
export const DB_HOST_SETTING = 'mithilesh_clock.discordDashboard.dbHost';

/** Shell settings key holding the database name — `db_postgres` only. */
export const DB_NAME_SETTING = 'mithilesh_clock.discordDashboard.dbName';

/** Shell settings key holding the database user — `db_postgres` only. */
export const DB_USER_SETTING = 'mithilesh_clock.discordDashboard.dbUser';

/**
 * Shell settings key naming the variable that holds the database password.
 *
 * `format: rocketride.envkey`, so the VALUE is the variable NAME and the
 * password itself stays encrypted on the server — the same contract as the
 * bot token. `db_postgres` only.
 */
export const DB_PASSWORD_SETTING = 'mithilesh_clock.discordDashboard.dbPassword';

/**
 * Manifest defaults for the variable-name settings, mirrored in code.
 *
 * The shell fills setting defaults from the app's registered configuration.
 * A dev-overlay preview (App Builder) registers only the bundle, never the
 * manifest, so `settings[key]` is undefined there and the checklist could
 * never tick step 1. Keep these equal to `package.json` `contributes`.
 */
export const SETTING_DEFAULTS: Record<string, string> = {
	[BOT_TOKEN_SETTING]: 'ROCKETRIDE_DISCORD_DISCORD_BOT_TOKEN',
	[OPENAI_KEY_SETTING]: 'ROCKETRIDE_OPENAI_KEY',
	[GITHUB_TOKEN_SETTING]: 'ROCKETRIDE_GITHUB_TOKEN',
	[QDRANT_HOST_SETTING]: 'ROCKETRIDE_QDRANT_HOST',
	[SLACK_WEBHOOK_SETTING]: 'ROCKETRIDE_SLACK_WEBHOOK_URL',
	[DB_PROVIDER_SETTING]: 'db_postgres',
	[DB_HOST_SETTING]: '127.0.0.1:55432',
	[DB_NAME_SETTING]: 'discord_dashboard',
	[DB_USER_SETTING]: 'rr_discord',
	[DB_PASSWORD_SETTING]: 'ROCKETRIDE_DISCORD_PG_PASSWORD',
};

/** Screens in navigation order. Settings is last, per the UX spec. */
export type ScreenId = 'bot' | 'conversations' | 'quality' | 'knowledge' | 'settings';

/** Settings sub-pages in navigation order. */
export type SettingsTabId = 'discord' | 'behavior' | 'pipeline' | 'advanced' | 'eval';

/** Which `.pipe` the bot task runs. */
export type PipeChoice = 'min' | 'rag' | 'ralph' | 'ralphSlack';

/** The node's reply modes (`discord.replyMode` enum in services.json). */
export type ReplyMode = 'channel' | 'reply' | 'thread';

/**
 * What the bot did with one captured question.
 *
 * `pending` is the transient state between the question arriving and the
 * node's `outbound` / `no_reply` event: the four spec outcomes are all
 * conclusions, and labelling a question asked 200 ms ago "no reply" would be
 * wrong data on the screen.
 *
 * `quiet` is a DELIBERATE silence: the node stayed out of a thread it had
 * already escalated (`escalationPause`), or the message was aimed at someone
 * else (`ignoreAimedAtOthers`). It is a member of this union rather than a flag
 * beside `no_reply` because every screen already switches on the outcome — the
 * badge, the filter strip, the grid's enum column and the "Needs you" test —
 * and a second dimension would have to be threaded through all four to say the
 * one thing the union says once: nobody has to act on this row.
 */
export type Outcome = 'pending' | 'answered' | 'escalated' | 'no_reply' | 'quiet' | 'error';

// =============================================================================
// SETTINGS
// =============================================================================

/** Settings › Discord — ids the app substitutes into the pipeline. */
export interface DiscordSettings {
	/** `discord.guildIds` — the server the bot listens to. */
	guildId: string;
	/** `discord.channelIds` — support channels (thread parents match too). */
	supportChannelIds: string[];
	/** `discord.requireMentionChannelIds` — guest channels needing an @mention. */
	mentionChannelIds: string[];
	/** `discord.allowedMentionRoleIds` — the escalation role. */
	teamRoleId: string;
	/** `discord.allowedBotIds` — bots allowed through the ignore-bots gate. */
	allowedBotIds: string[];
}

/** Settings › Behavior — how the bot answers. */
export interface BehaviorSettings {
	/** `discord.replyMode`. */
	replyMode: ReplyMode;
	/** `discord.threadName`. */
	threadName: string;
	/** `discord.threadNameMaxLength`. */
	threadNameMaxLength: number;
	/** `discord.threadAutoArchiveMinutes`. */
	threadAutoArchiveMinutes: number;
	/** `discord.showTyping`. */
	showTyping: boolean;
	/** `discord.ignoreBots`. */
	ignoreBots: boolean;

	// --- Thread context (original bot: history on follow-ups) -----------------

	/** `discord.threadHistoryLimit` — 0 turns thread context off. */
	threadHistoryLimit: number;
	/** `discord.threadHistoryMaxChars` — cap on the prepended transcript. */
	threadHistoryMaxChars: number;

	// --- Escalation -----------------------------------------------------------

	/** `discord.escalationPause` — stay quiet in a thread after escalating. */
	escalationPause: boolean;
	/** `discord.escalationMarkers` — reply text that counts as an escalation. */
	escalationMarkers: string[];
	/**
	 * Rewrite the prompt's escalation instruction so the reply ends with a ping
	 * of the team role, and let that role mention through.
	 *
	 * The ONE field on this page that is not a `discord.*` parameter: it changes
	 * the prompt component and `allowedMentionRoleIds` in `resolvePipeline`
	 * instead. Off by default, because a test round that pings the team on every
	 * escalation is how a test round stops being welcome.
	 */
	pingTeamOnEscalation: boolean;

	// --- Aimed at someone else ------------------------------------------------

	/** `discord.ignoreAimedAtOthers` — leave other people's messages alone. */
	ignoreAimedAtOthers: boolean;
	/** `discord.ackEmoji` — the reaction added to such a message. Empty = none. */
	ackEmoji: string;

	// --- Feedback reactions ---------------------------------------------------

	/** `discord.feedbackReactions` — add the feedback emoji to every answer. */
	feedbackReactions: boolean;
	/** `discord.feedbackEmojis` — the emoji it adds. */
	feedbackEmojis: string[];

	// --- Reply hygiene --------------------------------------------------------

	/** `discord.sanitizeReplies` — strip scaffolding, suppress non-answers. */
	sanitizeReplies: boolean;
}

/** Settings › Pipeline — which pipe is deployed and how restarts behave. */
export interface PipelineSettings {
	/** Which answer pipeline the bot task runs. */
	pipe: PipeChoice;
	/** Also run the shadow eval-capture pipe as a second task. */
	captureEnabled: boolean;
	/** Offer a restart automatically after a settings save. */
	restartAfterSave: boolean;
}

/** Settings › Advanced — ingestion limits and event emission. */
export interface AdvancedSettings {
	/** `discord.backfillLimit`. */
	backfillLimit: number;
	/** `discord.maxAttachmentBytes`. */
	maxAttachmentBytes: number;
	/** `discord.textAttachmentExtensions`. */
	textAttachmentExtensions: string[];
	/** `discord.textAttachmentMaxChars`. */
	textAttachmentMaxChars: number;
	/** `discord.emitReactions`. */
	emitReactions: boolean;
	/** `discord.emitNoReply`. */
	emitNoReply: boolean;
	/** `discord.emitOutbound`. */
	emitOutbound: boolean;
	/** `discord.includeMemberMetadata`. */
	includeMemberMetadata: boolean;
	/**
	 * The bot writes every event straight into the dashboard database.
	 *
	 * `resolvePipeline` adds a `capture_db` component to the bot's pipeline and
	 * points the discord source at it, so capture is
	 * the NODE's job rather than the browser's. With it off, nothing is
	 * captured while the dashboard is closed — which is why it is on by
	 * default.
	 */
	captureToDatabase: boolean;
	/** Render labelled sample rows and disable every action. */
	sampleData: boolean;
}

/**
 * Settings › Eval — who counts as the team, what is a test, and the tunables
 * the grading stages read.
 *
 * None of these are `discord.*` parameters: they configure the app's own
 * labelling of what it captured, which is why they are a slice of their own
 * rather than more fields on Behavior. The values and defaults are the
 * reference bot's `eval/config.ts` environment variables — the ones the app can
 * decide for itself. The eval bot's own token variable is NOT here: that is a
 * manifest setting, like the other secrets.
 */
export interface EvalSettings {
	/**
	 * Team members without the escalation role.
	 *
	 * `EVAL_TEAM_USER_IDS`. A reply from anyone on the role OR in this list is a
	 * team reply, which is what turns an escalation into `deferred` rather than
	 * `deferred_unanswered`.
	 */
	teamUserIds: string[];
	/**
	 * Bots whose questions are test traffic, excluded from the score.
	 *
	 * `TEST_ALLOW_BOT_IDS`. Empty means "the bots Settings › Discord already
	 * lets through" (`discord.allowedBotIds`) — see `testBotIdsOf`.
	 */
	testBotIds: string[];
	/** `EVAL_QUIET_HOURS` — a thread is gradeable once it has been this quiet. */
	quietHours: number;
	/** `EVAL_WINDOW_DAYS` — the trailing window the score is computed over. */
	windowDays: number;
	/** `EVAL_TARGET` — the resolved-rate target the score is read against. */
	target: number;
	/**
	 * `EVAL_MATCH_SCORE` — the retrieval DISTANCE at or below which the knowledge
	 * base counts as already holding an answer.
	 *
	 * Renamed from `matchScore` in stage 2, with the default moved from 0.7 to
	 * 0.8, because `eval-retrieve.pipe` returns Chroma's own number and that is a
	 * distance: LOWER is closer. A real docs question tops out around 0.78 and
	 * nonsense sits around 0.91, so the old name (and the old comparison) read the
	 * number backwards — see `analyzeRetrievalDistance` in `src/eval/rules.ts`.
	 */
	matchDistance: number;
	/** `EVAL_REASK_DAYS` — window in which the same question asked again counts as a re-ask. */
	reaskDays: number;
	/**
	 * Grade open rows immediately instead of waiting out {@link quietHours}.
	 *
	 * Testing only, and off by default: a thread graded minutes after the answer
	 * lands scores a conversation somebody was still reading, which is exactly
	 * what the quiet period exists to prevent.
	 */
	gradeNowIgnoresQuiet: boolean;
}

/** The whole settings form, one object per sub-page. */
export interface BotSettings {
	discord: DiscordSettings;
	behavior: BehaviorSettings;
	pipeline: PipelineSettings;
	advanced: AdvancedSettings;
	eval: EvalSettings;
}

/** One sub-page's group of settings — the unit a save writes. */
export type SettingsSlice = keyof BotSettings;

/** Every settings slice, for a writer that really did change all of them. */
export const SETTINGS_SLICES: SettingsSlice[] = ['discord', 'behavior', 'pipeline', 'advanced', 'eval'];

// =============================================================================
// CONVERSATIONS
// =============================================================================

/** One captured question and what became of it. */
export interface ConversationRow extends Record<string, unknown> {
	/** `metadata.messageId` — the row identity. */
	id: string;
	/** Unix ms the app saw the first event for this message. */
	seenAt: number;
	/** `metadata.channelId`. */
	channelId: string;
	/** `metadata.guildId` — needed to build the "Open in Discord" link. */
	guildId: string | null;
	/** `metadata.threadId`, when the message arrived in a thread. */
	threadId: string | null;
	/** `metadata.authorId`. */
	authorId: string;
	/** `metadata.authorDisplayName`, when member metadata is on. */
	authorName: string | null;
	/** `metadata.correlationId` — shared by every object from one message. */
	correlationId: string;
	/** First line of the question, as far as the events carry it. */
	question: string;
	/** The bot's answer text from the `outbound` event, when there was one. */
	answer: string | null;
	/**
	 * Ids of the messages the bot posted as the answer (`outbound.messageIds`).
	 *
	 * Kept because a `reaction` event names the message that was REACTED TO,
	 * which is the bot's answer and not the question — these ids are how such a
	 * reaction finds its way back to this row.
	 */
	replyMessageIds?: string[];
	/** What the bot did. */
	outcome: Outcome;
	/** The node's reason string on a `no_reply` event. */
	reason: string | null;
	/** Attachment names and sizes from the message metadata. */
	attachments: { name: string | null; size: number | null }[];
	/** Emoji captured from `reaction` events on the bot's reply. */
	reactions: string[];
	/** Unix ms of the last event that touched this row. */
	updatedAt: number;
	/**
	 * A team-role member has posted in the thread since the escalation, so the
	 * row has left the "Needs you" list (UX spec F2's exit condition).
	 *
	 * The node emits no `team_reply` event, so this is derived: a later
	 * `message` event in the same thread whose `authorRoleIds` carry the
	 * configured team role id.
	 */
	teamReplied?: boolean;
	/**
	 * A Slack page was triggered for this thread.
	 *
	 * Read from the first escalation reply in the thread on a pipe that pages
	 * Slack (its rows' `source` ends in `+tool_slack`); see
	 * `applyEscalationPage` in src/db/fold.ts. The engine never reports
	 * whether Slack accepted the post, so this is "a page was triggered", not
	 * "Slack received it".
	 */
	pagedSlack?: boolean;
	/** Row is a labelled sample, not live data. */
	sample?: boolean;

	// --- EVAL -----------------------------------------------------------------
	//
	// The reference bot kept two SQLite tables for this: `threads` (one row per
	// question) and `events` (everything that happened in its thread). A row here
	// is that thread row, and {@link events} is its slice of the event table —
	// the app has no database, and the workspace slice is the only store it gets.
	//
	// Every field is optional because a row captured before this existed has
	// none of them; `normalizeAppData` fills them in on load, so a reader gets
	// defaults rather than `undefined`. Nothing here is written by capture except
	// what capture can observe — the grade, the review and the replay flag are
	// placeholders the later stages fill.

	/**
	 * Everything that happened in this thread, ordered by `ts`.
	 *
	 * Insertion is idempotent on (type, message_id, actor_id, emoji), so a
	 * re-delivered SSE event cannot double-count — the events are what
	 * `decideOutcome` labels the row from, and a duplicated `team_reply` would
	 * change the label.
	 */
	events?: EvalEvent[];
	/** Who asked. The `question` event's actor, and the row's own author. */
	openerId?: string;
	/** The opener carries the team role or is in `eval.teamUserIds`. */
	openerIsTeam?: boolean;
	/** What the LAST reply the bot posted in this thread was. */
	replyClass?: RalphReplyType | null;
	/** Retried text passes seen for this question (the node's `retry` key). */
	retries?: number;
	/** Where the row is in the eval loop. Any new event reopens a graded row. */
	evalStatus?: 'open' | 'graded' | 'reviewed';
	/** The eval label. Null until a grader has run. */
	evalOutcome?: EvalOutcome | null;
	/** Why it failed. Null for a success, or until a grader has run. */
	evalCause?: EvalCause | null;
	/** Whether the outcome was decided by the rules or by a human review. */
	outcomeSource?: 'auto' | 'review' | null;
	/** Whether the cause was decided by the rules or by a human review. */
	causeSource?: 'auto' | 'review' | null;
	/** Why the row is out of the denominator: internal, test, manipulation. */
	excludedReason?: string | null;
	/** Unix ms of the last event in the thread — what "quiet enough to grade" reads. */
	lastActivityAt?: number;
	/** The grader's output, written by one pass of `runGradeBatch`. */
	grade?: {
		/**
		 * The grader LLM's own JSON, verbatim, plus `_auto_outcome` and
		 * `_auto_cause` — the reference's `grader_json` column. Stored as TEXT so a
		 * later review can show exactly what the model said, including fields the
		 * app does not read.
		 */
		graderJson: string;
		/**
		 * Smallest Chroma DISTANCE the QUESTION retrieved, or null when the
		 * retrieval returned nothing. Lower is closer — see
		 * `EvalSettings.matchDistance`.
		 */
		qTopScore: number | null;
		/** The same for the TEAM's answer text, or null when there was none. */
		aTopScore: number | null;
		/** The {@link GraderCluster} this thread was grouped into, if any. */
		clusterId: string | null;
		/** Unix ms this grade was written. */
		gradedAt: number;
	} | null;
	/** The Q/A pair a grader proposed for the knowledge base. */
	qaDraft?: { question: string; answer: string } | null;
	/** The Q/A pair a human approved, and whether it reached the KB. */
	qaApproved?: {
		question: string;
		answer: string;
		approvedBy: string;
		approvedAt: number;
		ingestedAt: number | null;
	} | null;
	/** Who reviewed the row. */
	reviewedBy?: string | null;
	/** Unix ms of that review. */
	reviewedAt?: number | null;
	/** The row was opened by the eval/replay bot, not by a real asker. */
	replay?: boolean;
}

// =============================================================================
// QUALITY
// =============================================================================

/** A replay verdict for one seed question. */
export type SeedStatus = 'pass' | 'fail' | 'hard_fail';

/**
 * One seed's result: one line of an imported replay JSONL file, and one row of a
 * run the app drove itself.
 *
 * The five fields above the divider are the IMPORT FORMAT, unchanged — the
 * harness's JSONL carries exactly those, and `parseReplayJsonl` still reads a
 * file that has nothing else. Everything below is what a run driven by the app
 * knows and an imported line does not, which is why all of it is optional: an
 * imported run and a locally-driven run are the same shape, and the table below
 * simply shows a dash where an import has nothing to say.
 *
 * The two Discord fields a posted run used to carry (`postedMessageId`,
 * `threadId`) are gone: a run asks a PRIVATE COPY of the bot's pipeline
 * (`src/eval/replayCopy.ts`), so there is no posted message and no thread. A file
 * that still has them imports fine — the extra keys are simply ignored.
 */
export interface SeedResult extends Record<string, unknown> {
	/** Seed id, stable across runs — what a regression is keyed on. */
	id: string;
	/** The seed question. */
	question: string;
	/** Pass / fail / hard fail. */
	status: SeedStatus;
	/** The judge's verdict line. */
	verdict: string;
	/** The judge's notes. */
	notes: string;

	// --- Driven by the app ----------------------------------------------------

	/**
	 * What the copy replied, as the bot's node would have posted it, or null when
	 * there was nothing to post.
	 */
	reply?: string | null;
	/** The reply was an escalation rather than an answer. */
	escalated?: boolean;
	/**
	 * The `project_id` of the pipeline that answered.
	 *
	 * Always the replay copy's (`REPLAY_COPY_PROJECT_ID`). On the record because it
	 * is the proof that the answer came from the copy and not from the live bot.
	 */
	copyProjectId?: string | null;
	/**
	 * The seed had to be asked twice.
	 *
	 * The first answer sanitized to nothing, so the run asked once more under a new
	 * object name — the node's own `nonAnswerRetries` behaviour. Worth recording:
	 * a seed that only passes on the retry is a flaky answer, not a good one.
	 */
	retried?: boolean;
}

/**
 * One replay run — imported from the harness's JSONL, or driven by the app.
 *
 * {@link importedAt} and {@link fileName} are the import's own fields and stay
 * required, so the two sources share one type; a driven run fills them with the
 * moment it finished and a synthetic name (see `runFileName` in
 * `src/eval/replay.ts`). The counters below are optional for the same reason the
 * extra {@link SeedResult} fields are: an import has no idea what its own hard
 * fails or regressions were until they are recomputed from the seeds.
 */
export interface ReplayRun {
	/** Unix ms the run was imported, or finished. */
	importedAt: number;
	/** The file it came from, or the name a driven run gave itself. */
	fileName: string;
	/** Per-seed results, in file order. */
	seeds: SeedResult[];

	// --- Driven by the app ----------------------------------------------------

	/** Unix ms the first seed was posted. */
	startedAt?: number;
	/** Unix ms the last seed settled. */
	finishedAt?: number;
	/** How many seeds the run covered — the reference's `n`. */
	n?: number;
	/** How many came back `pass`. `partial` is NOT a pass. */
	passed?: number;
	/** How many were hard fails, counted the reference's way. */
	hardFails?: number;
	/** Seeds that passed on the run before this one and do not pass now. */
	regressions?: string[];
	/** The run stopped early because someone pressed Stop, or the engine failed. */
	stoppedEarly?: boolean;
}

/**
 * One problem cluster the grader groups threads into.
 *
 * The reference bot kept these in a `clusters` table and handed the list to the
 * grader on every call, so the model reuses a cluster it has already proposed
 * instead of inventing a synonym. The id is a string here rather than the
 * reference's SQLite rowid — see `upsertCluster` in `src/eval/grader.ts` for why
 * it is derived from the label.
 */
export interface GraderCluster {
	/** Stable id, derived from the label. What `grade.clusterId` points at. */
	id: string;
	/** Short name the grader proposed. Clusters are upserted BY this. */
	label: string;
	/** One line saying what the cluster is. */
	description: string;
}

/** What a replay case expects the bot to do with its question. */
export type GoldenExpectation = 'answer' | 'escalate';

/**
 * One case in the golden set — a question with the behaviour a replay should
 * hold the bot to.
 *
 * The reference bot's `golden_cases` table. Seeded from ONE place in this app:
 * teaching Ralph an answer on the Review tab, which is the only moment a human
 * has said both "this is the question" and "this is the right answer". The
 * replay stage reads the set; nothing here runs it.
 *
 * `expected` follows the cause rather than the answer text: a thread that failed
 * because it needed an account or another human action (`policy_account` /
 * `policy_other`) is a question the bot SHOULD escalate, so a replay that
 * answers it has regressed — which is why an `escalate` case carries no
 * {@link goldenAnswer}.
 */
export interface GoldenCase {
	/** `thread-<threadId>`: one case per thread, so re-teaching updates it. */
	id: string;
	/** The question as the reviewer approved it. */
	question: string;
	/** What a correct run does: answer it, or escalate it. */
	expected: GoldenExpectation;
	/** The answer a replay judges against. Null for an `escalate` case. */
	goldenAnswer: string | null;
	/** Where the case came from. Only `'review'` is written today. */
	source: 'review' | 'guardrail' | 'manual';
	/** The thread it was taken from — the dedupe key. */
	threadId: string;
	/** Whether the case is in the set. */
	active: boolean;
	/** Unix ms the case was created. */
	createdAt: number;
}

/**
 * The Quality screen's persisted data: this run and the one before it, plus what
 * the grader accumulates across batches and what review teaches.
 *
 * {@link clusters}, {@link lastGradedAt} and {@link golden} are OPTIONAL because
 * the sample-data pair (`sampleQuality` in `src/sample.ts`) is a literal with
 * none of them, and `normalizeAppData` fills them on load, so live readers see
 * them.
 */
export interface QualityState {
	lastRun: ReplayRun | null;
	previousRun: ReplayRun | null;
	/** The clusters the grader has proposed so far, in the order it made them. */
	clusters?: GraderCluster[];
	/** Unix ms the last grading batch finished, or null before the first one. */
	lastGradedAt?: number | null;
	/** The golden set, seeded by the teach flow. Keyed by thread — see {@link GoldenCase}. */
	golden?: GoldenCase[];
}

// =============================================================================
// THE SHAPE THE SCREENS READ
// =============================================================================

/** Get-started checklist steps (UX spec F1). */
export type ChecklistStepId = 'token' | 'channels' | 'role' | 'start' | 'firstQuestion';

/**
 * Everything the screens render, assembled from the database on each load.
 *
 * `version` stays 1 and stays a literal: it is the shape's version, and the
 * shape has not changed — only where it comes from. The database's own
 * version is `dd_meta.schema_version`.
 */
export interface AppData {
	/** Shape version. */
	version: 1;
	settings: BotSettings;
	/** Steps the setup checklist has seen done, derived from live facts. */
	checklist: Record<ChecklistStepId, boolean>;
	/**
	 * Task token of the running bot pipeline.
	 *
	 * Runtime state only, resolved from the server by `(projectId, source)` on
	 * every load. Never persisted — a stale token is worse than none.
	 */
	taskToken: string | null;
	/** Task token of the shadow eval-capture pipeline. Runtime state only. */
	captureToken: string | null;
	/** Captured conversations, oldest first, folded from `dd_events`. */
	conversations: ConversationRow[];
	/** Replay runs, clusters, golden set and the last-graded stamp. */
	quality: QualityState;
	/** Thread ids dismissed from the "Needs you" list (`dd_threads.dismissed`). */
	dismissed: string[];
}

/**
 * Hard cap on the conversation rows one session folds into memory.
 *
 * It used to be a STORAGE cap — the workspace file was the only store, and a
 * row past the cap was gone. Now it is a display cap: every event stays in
 * `dd_events` for good, and raising this only costs the browser memory.
 */
export const MAX_CONVERSATIONS = 2000;

// =============================================================================
// UI PREFERENCES — the only thing still in appState
// =============================================================================

/** Quality screen tabs, so the open tab can be remembered. */
export type QualityTabId = 'scorecard' | 'review' | 'replay';

/**
 * What one viewer's browser remembers between sessions.
 *
 * Preferences and nothing else: where the user was, and which chips they had
 * on. Nothing here is shared, nothing here is data, and losing all of it costs
 * one click.
 */
export interface UiPrefs {
	/** Slice version. Version 1 was the whole app — see {@link APP_STATE_KEY}. */
	version: 2;
	/** The screen that was open. */
	screen: ScreenId;
	/** The Settings sub-page that was open. */
	settingsTab: SettingsTabId;
	/** The Quality tab that was open. */
	qualityTab: QualityTabId;
	/** The Conversations grid's column filters. */
	conversationFilters: Record<string, string | string[]>;
	/** The Review tab's filter chips. */
	reviewFilters: string[];
}

/** What a first run starts from. */
export const DEFAULT_UI_PREFS: UiPrefs = {
	version: 2,
	screen: 'bot',
	settingsTab: 'discord',
	qualityTab: 'scorecard',
	conversationFilters: {},
	// The two piles that need a person — `DEFAULT_REVIEW_FILTERS` in
	// `src/eval/review.ts`, mirrored here because this module is types and
	// constants only.
	reviewFilters: ['needs_verdict', 'misses'],
};

/** Merge one patch into the stored preferences. */
export type UpdateUiPrefs = (patch: Partial<Omit<UiPrefs, 'version'>>) => void;

// =============================================================================
// DEFAULTS — titles and values from nodes/src/nodes/discord/services.json
// =============================================================================

/** The node's own defaults, so an untouched form matches the node's behavior. */
export const DEFAULT_SETTINGS: BotSettings = {
	discord: {
		guildId: '',
		supportChannelIds: [],
		mentionChannelIds: [],
		teamRoleId: '',
		allowedBotIds: [],
	},
	behavior: {
		// The support bot answers in a thread per question (feature 1), which is
		// what both shipped pipes configure; the node's own default is 'reply'.
		replyMode: 'thread',
		threadName: '{content}',
		threadNameMaxLength: 90,
		threadAutoArchiveMinutes: 1440,
		showTyping: true,
		ignoreBots: true,
		// The five behaviors below are opt-in on the NODE (its defaults are 0,
		// false, [], false, '') and opt-OUT here, because this app's job is the
		// original support bot and that bot ran them all: 50 messages of thread
		// history on follow-ups, quiet in a thread it had already escalated, a 👀
		// on messages aimed at someone else, and no reasoning scaffolding in a
		// reply. Feedback reactions are the one exception — see below.
		threadHistoryLimit: 50,
		threadHistoryMaxChars: 6000,
		escalationPause: true,
		// The line the shipped prompts tell the model to end an escalating reply
		// with — `ESCALATION_LINE` in `pipeline/resolve.ts`, and the pattern
		// `outcomeOfReply` recognises. Kept as a literal here because this module
		// is types and constants only, and importing the pipes to reach it would
		// drag four `.pipe` documents into every consumer.
		escalationMarkers: ['Escalated to the RocketRide team.'],
		// Off until someone asks for it: an escalation that pings the team role is
		// a notification to real people, and the first rounds of any deployment are
		// test rounds.
		pingTeamOnEscalation: false,
		ignoreAimedAtOthers: true,
		ackEmoji: '👀',
		// Off by default: ✅/❌ on every answer is a request for feedback nobody
		// agreed to give, and the Reactions column captures what readers add
		// unprompted either way.
		feedbackReactions: false,
		feedbackEmojis: ['✅', '❌'],
		sanitizeReplies: true,
	},
	pipeline: {
		pipe: 'min',
		captureEnabled: false,
		restartAfterSave: true,
	},
	advanced: {
		backfillLimit: 0,
		maxAttachmentBytes: 26214400,
		textAttachmentExtensions: ['.pipe', '.json', '.log', '.md', '.txt', '.csv', '.yaml', '.yml'],
		textAttachmentMaxChars: 12000,
		emitReactions: false,
		emitNoReply: true,
		emitOutbound: true,
		// On by default: F2's exit condition (an escalation clears when a
		// team-role member replies) is derived from `authorRoleIds`, and the
		// Asker column wants display names, so the app's own contract needs it.
		// It costs the privileged Server Members intent, which Settings › Discord
		// says out loud.
		// Off by default: it needs the privileged Server Members Intent, and a bot
		// without it fails to log in at all. Turn on once the intent is enabled.
		includeMemberMetadata: false,
		// On by default: the dashboard is a window on the data, not the thing
		// that collects it. With capture off, a question asked while nobody has
		// the app open is a question nothing ever recorded.
		captureToDatabase: true,
		sampleData: false,
	},
	eval: {
		// No team ids and no test bots until someone says so: guessing either
		// would silently exclude real traffic from the score.
		teamUserIds: [],
		testBotIds: [],
		// The reference bot's own defaults (eval/config.ts): a thread is graded
		// once it has been quiet for two days, the headline score is the trailing
		// four weeks against 60%, and the same question inside a fortnight is a
		// re-ask rather than a new question. The match threshold is the one value
		// that is NOT the reference's: it is a Chroma distance here, not a
		// similarity, and 0.8 sits between a real docs question (~0.78) and
		// nonsense (~0.91) — see `matchDistance`.
		quietHours: 48,
		windowDays: 28,
		target: 0.6,
		matchDistance: 0.8,
		reaskDays: 14,
		gradeNowIgnoresQuiet: false,
	},
};

/** What the screens see before the first load lands, and in sample mode. */
export const EMPTY_APP_DATA: AppData = {
	version: 1,
	settings: DEFAULT_SETTINGS,
	checklist: { token: false, channels: false, role: false, start: false, firstQuestion: false },
	taskToken: null,
	captureToken: null,
	conversations: [],
	quality: { lastRun: null, previousRun: null, clusters: [], lastGradedAt: null, golden: [] },
	dismissed: [],
};
