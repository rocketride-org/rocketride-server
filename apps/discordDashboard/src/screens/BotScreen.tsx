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
// BOT — the daily landing: status, get started, what needs you
// =============================================================================
//
// Above the fold, in this order (UX spec §4: "status and the first three needs-you
// rows"): the status header, then the "Needs you" list, and only after it the
// Get-started card. The checklist is live for as long as setup is incomplete, so
// putting it first would push the rows the responder came for off the screen for
// exactly as long as they are hardest to find.
//
// "Needs you" is not a dashboard of everything — it is the two things a
// responder has to act on: threads the bot escalated to the team role, and
// questions the bot did not answer, both within the last 24 hours. A row
// leaves when a team-role member replies in the thread or when it is
// dismissed.
// =============================================================================

import React, { useMemo } from 'react';
import { BOT_TOKEN_SETTING } from '../state/types';
import type { ConversationRow } from '../state/types';
import { FAILURES_BEFORE_LOG } from '../bot/useBotTask';
import { PIPE_LABELS } from '../pipeline/resolve';
import { sampleConversations, SAMPLE_BOT_NAME, SAMPLE_CHANNEL_ID, SAMPLE_GUILD_ID } from '../sample';
import { discordLink, firstLine, formatAge, OutcomeChip, SampleBanner, Skeleton } from '../ui/parts';
import { Btn, Chip, DdBanner, DdCard, DdEmpty, ExtLink, IdText, PageHeader, QuestionLine, shortWhen, type Tone } from '../ui/dd';
import { useToast } from '../ui/toast';
import { Checklist } from './Checklist';
import type { ChecklistStep } from './Checklist';
import type { ScreenProps } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The window "Needs you" covers (UX spec F2). */
const NEEDS_YOU_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How a phase reads in the status header. */
const PHASE_LABEL: Record<string, string> = {
	unknown: 'Not running',
	stopped: 'Stopped',
	starting: 'Starting',
	running: 'Connected',
	failed: 'Disconnected',
};

/** Chip tone per phase. */
const PHASE_TONE: Record<string, Tone> = {
	unknown: 'neutral',
	stopped: 'neutral',
	starting: 'info',
	running: 'ok',
	failed: 'bad',
};

/** The big word in the status card, per phase. */
const PHASE_WORD: Record<string, string> = {
	unknown: 'Not running',
	stopped: 'Stopped',
	starting: 'Starting',
	running: 'Running',
	failed: 'Disconnected',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The rows that need a human, newest first.
 *
 * The `quiet` outcome is absent from the test on purpose: a thread the bot kept
 * out of because it had already escalated there, or a message that was aimed at
 * somebody else, is the bot behaving — there is nothing for a responder to do
 * about it, and a list that fills with those stops being read. Those rows are on
 * Conversations, badged Quiet, with the node's reason in the side panel. A
 * suppressed non-answer is NOT quiet: that is a question nobody answered.
 *
 * @param rows - Every captured conversation.
 * @param dismissed - Message ids the user has dismissed.
 * @param now - Unix ms.
 * @returns Escalated and unanswered rows from the last 24 hours.
 */
function needsYou(rows: ConversationRow[], dismissed: string[], now: number): ConversationRow[] {
	return rows
		.filter((row) => {
			if (dismissed.includes(row.id)) return false;
			if (row.teamReplied === true) return false;
			if (now - row.seenAt > NEEDS_YOU_WINDOW_MS) return false;
			return row.outcome === 'escalated' || row.outcome === 'no_reply' || row.outcome === 'error';
		})
		.slice()
		.sort((a, b) => b.seenAt - a.seenAt);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Bot screen.
 *
 * @param props - See {@link ScreenProps}.
 * @returns The screen.
 */
export const BotScreen: React.FC<ScreenProps> = ({ data, actions, loaded, bot, sampleMode, writesBlocked, goto, openOverlay, serverVariables, tokenVariable }) => {
	const toast = useToast();
	const { settings } = data;
	// One clock read per render keeps every age on the screen consistent.
	const now = Date.now();

	// --- The five checklist steps (UX spec F1) --------------------------------

	const steps = useMemo<ChecklistStep[]>(() => {
		// The CONFIGURED name, not a literal: renaming the variable in the shell's
		// app settings must move this test with it. An unknown variable list falls
		// back to the persisted tick rather than un-ticking a finished step.
		const tokenSaved = tokenVariable.length > 0 && (serverVariables?.includes(tokenVariable) ?? false);
		const channelsSet = settings.discord.guildId.trim().length > 0 && settings.discord.supportChannelIds.filter((id) => id.trim()).length > 0;
		const roleSet = settings.discord.teamRoleId.trim().length > 0;
		return [
			{
				id: 'token',
				label: 'Save the bot token as a server variable',
				detail: `The app never holds the token. Save it on the server as ${tokenVariable || 'the variable named in the app settings'}, then name that variable in the app settings.`,
				done: tokenSaved || data.checklist.token,
				actionLabel: 'Open variables',
				onAction: () => openOverlay('environment'),
			},
			{
				id: 'channels',
				label: 'Enter the server and support channel ids',
				detail: 'Settings › Discord. The bot listens only to the channels you list here.',
				done: channelsSet,
				actionLabel: 'Open settings',
				onAction: () => goto('settings', 'discord'),
			},
			{
				id: 'role',
				label: 'Enter the team role id for escalations',
				detail: 'The one role the bot is allowed to ping when it cannot answer.',
				done: roleSet,
				actionLabel: 'Open settings',
				onAction: () => goto('settings', 'discord'),
			},
			{
				id: 'start',
				label: 'Start the bot',
				detail: `Runs the ${PIPE_LABELS[settings.pipeline.pipe]} pipeline until you stop it.`,
				done: bot.phase === 'running' || bot.phase === 'starting' || data.checklist.start,
				actionLabel: 'Start',
				onAction: () => {
					void handleStart();
				},
			},
			{
				id: 'firstQuestion',
				label: 'Post a test question in Discord',
				detail: 'The first question the bot sees shows up under Conversations.',
				done: data.conversations.length > 0 || data.checklist.firstQuestion,
				actionLabel: 'Open Conversations',
				onAction: () => goto('conversations'),
			},
		];
		// `handleStart` is stable for the render it is captured in; the steps are
		// re-derived on every render anyway, so a dependency list here would only
		// stale the closure.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settings, data.checklist, data.conversations.length, bot.phase, serverVariables, tokenVariable, goto, openOverlay]);

	// --- Actions --------------------------------------------------------------

	/** Start the bot and report the outcome. */
	async function handleStart(): Promise<void> {
		const failure = await bot.start();
		if (failure === null) toast.success('Bot started.');
		else toast.error(`Could not start the bot: ${failure}`);
	}

	/** Restart the bot and report the outcome. */
	async function handleRestart(): Promise<void> {
		const failure = await bot.restart();
		if (failure === null) toast.success('Bot restarted.');
		else toast.error(`Could not restart the bot: ${failure}`);
	}

	/** Stop the bot and report the outcome. */
	async function handleStop(): Promise<void> {
		const failure = await bot.stop();
		if (failure === null) toast.success('Bot stopped.');
		else toast.error(`Could not stop the bot: ${failure}`);
	}

	/**
	 * Drop one row from the "Needs you" list for good.
	 *
	 * SHARED, which it was not before: a dismissal is a decision that this
	 * thread needs nobody, and it used to be one admin's browser's opinion.
	 * It is a `dd_threads` column now, so the responder who dismissed it and
	 * the one who did not see the same list.
	 */
	function dismiss(id: string): void {
		if (writesBlocked !== null) {
			toast.error(`${writesBlocked}. The row could not be dismissed.`);
			return;
		}
		void actions.dismiss(id).catch((err: unknown) => {
			toast.error(`Could not dismiss the row: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	// --- States ---------------------------------------------------------------

	const rows = sampleMode ? sampleConversations(now) : data.conversations;
	const dismissedIds = sampleMode ? [] : data.dismissed;
	const pending = needsYou(rows, dismissedIds, now);
	const configured = settings.discord.guildId.trim().length > 0 && settings.discord.supportChannelIds.filter((id) => id.trim()).length > 0;

	// LOADING: the workspace has not been read, or the first status has not
	// landed. The skeleton stands in for the status card only — the rest of the
	// screen depends on it.
	const subtitle = "Ralph's health, and the threads waiting for a human.";

	if (!sampleMode && (!loaded || bot.loading)) {
		return (
			<div className="dd-page">
				<PageHeader title="Bot" subtitle={subtitle} />
				<DdCard>
					<Skeleton rows={4} label="Loading the bot status" />
				</DdCard>
			</div>
		);
	}

	const phase = sampleMode ? 'running' : bot.phase;
	const statusLine = sampleMode ? 'Watching 1 channel. Sample data — nothing here is live.' : (bot.status?.status ?? '');
	const botName = sampleMode ? SAMPLE_BOT_NAME : bot.botName;
	// F5: the error state owns its own Restart, so the header does not offer a
	// second one beside it.
	const showError = !sampleMode && bot.error !== null;
	// Two failed recoveries in a row is where F5 stops repeating itself and
	// shows the engine's own log tail instead.
	const showLog = showError && bot.failures >= FAILURES_BEFORE_LOG && bot.logExcerpt.length > 0;
	const channelIds = sampleMode ? [SAMPLE_CHANNEL_ID] : settings.discord.supportChannelIds.filter((id) => id.trim());
	const guildId = sampleMode ? SAMPLE_GUILD_ID : settings.discord.guildId.trim();
	const checklistOpen = steps.some((step) => !step.done);

	// Page actions: the same three buttons as before, in the page header. Start
	// is the page's one primary action and stays disabled while running.
	const pageActions = (
		<div className="dd-row">
			<Btn variant="primary" icon="play" onClick={() => void handleStart()} disabled={sampleMode || bot.busy || phase === 'running' || phase === 'starting' || bot.missing.length > 0} title={sampleMode ? 'Turn off Sample data to start the bot' : bot.missing.length > 0 ? `Missing: ${bot.missing.join(', ')}` : 'Start the bot'}>
				{bot.busy ? 'Working…' : 'Start'}
			</Btn>
			{!showError && (
				<Btn icon="rotate" onClick={() => void handleRestart()} disabled={sampleMode || bot.busy || phase === 'unknown'} title={sampleMode ? 'Turn off Sample data to restart the bot' : 'Restart the bot'}>
					Restart
				</Btn>
			)}
			<Btn variant="danger" icon="stop" onClick={() => void handleStop()} disabled={sampleMode || bot.busy || bot.token === null} title={sampleMode ? 'Turn off Sample data to stop the bot' : 'Stop the bot'}>
				Stop
			</Btn>
		</div>
	);

	const needsYouCard = (
		<DdCard
			title={
				<>
					Needs you <span className="dd-count">{pending.length}</span>
				</>
			}
			actions={<span className="dd-caption">{pending.length} open</span>}
		>
			{pending.length === 0 ? (
				<DdEmpty icon="inbox" title="Nothing needs you right now" description="Escalated threads and unanswered questions from the last 24 hours show up here." />
			) : (
				<div className="dd-rowlist">
					{pending.map((row) => {
						const href = discordLink(row.guildId, row.threadId ?? row.channelId, row.id);
						return (
							<div key={row.id} className="dd-rowitem">
								<OutcomeChip outcome={row.outcome} />
								<span style={{ minWidth: 0 }}>
									<span className="dd-rowitem__q">
										<QuestionLine text={firstLine(row.question)} prefix={row.sample === true ? 'Sample: ' : ''} />
									</span>
									<span className="dd-rowitem__meta">
										<IdText kind={row.threadId !== null ? 'thread' : 'channel'} id={row.threadId ?? row.channelId} />
										<span>· {formatAge(row.seenAt, now)}</span>
										{row.reason !== null && row.reason !== 'no_answer' && <span>· {row.reason}</span>}
										{row.pagedSlack === true && <Chip tone="brand">Paged Slack</Chip>}
									</span>
								</span>
								{href !== null ? <ExtLink href={href}>Open in Discord</ExtLink> : <span className="dd-caption">No link</span>}
								<Btn small onClick={() => dismiss(row.id)} disabled={sampleMode} title={sampleMode ? 'Turn off Sample data to dismiss rows' : 'Take this row off the list'}>
									Dismiss
								</Btn>
							</div>
						);
					})}
				</div>
			)}
		</DdCard>
	);

	return (
		<div className="dd-page">
			<PageHeader title="Bot" subtitle={subtitle} actions={pageActions} />
			{sampleMode && <SampleBanner />}

			{/* --- Status first: is Ralph up? ---------------------------------- */}
			<DdCard>
				<div className="dd-stack" style={{ gap: 18, paddingTop: 6 }}>
					<div className="dd-row" style={{ gap: 14 }}>
						<span className="dd-avatar dd-avatar--ralph" style={{ width: 44, height: 44, fontSize: 16 }} aria-hidden="true">
							R
						</span>
						<div>
							<div className="dd-statusword">{PHASE_WORD[phase]}</div>
							{/* The bot's Discord identity comes out of the node's own ready
							    line; `status.name` is the TASK name, which this app sets, so
							    it is labelled as what it is rather than posing as the bot. */}
							<div className="dd-muted">
								{sampleMode || botName !== null ? (
									<>
										Connected as <strong className="dd-strong">{sampleMode ? SAMPLE_BOT_NAME : botName}</strong>
									</>
								) : (
									<>Task {bot.status?.name || 'Not connected'}</>
								)}
							</div>
						</div>
						<span className="dd-spacer" />
						<Chip tone={PHASE_TONE[phase]} live={phase === 'running'}>
							{PHASE_LABEL[phase]}
						</Chip>
						<Chip tone="neutral" icon="cpu">
							{PIPE_LABELS[settings.pipeline.pipe]}
						</Chip>
					</div>
					<div className="dd-facts" style={{ paddingTop: 16, borderTop: '1px solid var(--line)' }}>
						<div className="dd-fact">
							<span className="dd-eyebrow">Server</span>
							<span className="dd-fact__v">{guildId ? <IdText id={guildId} /> : 'Not set'}</span>
						</div>
						<div className="dd-fact">
							<span className="dd-eyebrow">{channelIds.length === 1 ? 'Support channel' : 'Support channels'}</span>
							<span className="dd-fact__v">
								{channelIds.length === 0
									? 'Not set'
									: channelIds.map((id, index) => (
											<React.Fragment key={id}>
												{index > 0 && ', '}
												<IdText kind="channel" id={id} />
											</React.Fragment>
										))}
							</span>
						</div>
						<div className="dd-fact">
							<span className="dd-eyebrow">Running since</span>
							<span className="dd-fact__v dd-num">{sampleMode ? shortWhen(now - 3 * 60 * 60 * 1000) : shortWhen(bot.status?.startTime ? bot.status.startTime * 1000 : undefined)}</span>
						</div>
						<div className="dd-fact">
							<span className="dd-eyebrow">Last message</span>
							<span className="dd-fact__v">{rows.length > 0 ? formatAge(rows[rows.length - 1].seenAt, now) : 'No messages yet'}</span>
						</div>
					</div>

					{statusLine.length > 0 && <span className="dd-caption dd-mono">{statusLine}</span>}

					{/* ERROR state (F5): the node's own fatal text, verbatim, with the
					    door to Settings. A second consecutive failed recovery adds the
					    engine's log tail rather than offering the same button again. */}
					{showError && (
						<div className="dd-stack">
							<DdBanner variant="error">
								<span className="dd-mono">{bot.error}</span>
							</DdBanner>
							{bot.failures > 0 && <p className="dd-help">{bot.failures === 1 ? 'One recovery attempt has failed so far.' : `${bot.failures} recovery attempts in a row have failed. The engine's last lines are below.`}</p>}
							{showLog && (
								<pre className="dd-pre" aria-label="Engine log excerpt">
									{bot.logExcerpt.join('\n')}
								</pre>
							)}
							<div className="dd-row">
								<Btn icon="rotate" onClick={() => void handleRestart()} disabled={bot.busy}>
									{bot.busy ? 'Restarting…' : 'Restart'}
								</Btn>
								<Btn variant="ghost" onClick={() => goto('settings', 'discord')}>
									Check Settings &rsaquo; Discord
								</Btn>
							</div>
						</div>
					)}

					{/* EMPTY state: nothing is configured yet, so say what is missing
					    rather than showing a dead status card alone. */}
					{!sampleMode && !configured && (
						<p className="dd-help">
							No bot configured. Work through Get started below — the token goes in as a server variable named <code className="dd-code">{tokenVariable || 'the name in the app settings'}</code>, never as a value in this app. The app reads its name from the <code className="dd-code">{BOT_TOKEN_SETTING}</code> setting.
						</p>
					)}
				</div>
			</DdCard>

			{/* --- Needs you, with Get started beside it ------------------------ */}
			{checklistOpen ? (
				<div className="dd-grid-main dd-grid-main--wide">
					{needsYouCard}
					<Checklist steps={steps} readOnly={sampleMode} />
				</div>
			) : (
				needsYouCard
			)}
		</div>
	);
};
