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
// CONVERSATIONS — every question the bot saw, and what became of it
// =============================================================================
//
// Read-only by design (UX spec §4: "No editing"). The rows come from the
// running task's events and are persisted in the app's workspace slice, so a
// reload keeps what was captured — but the app is not the event store: only
// what arrived while an app session was open is here, capped at
// MAX_CONVERSATIONS. That is the v1 limitation the README states.
//
// A row click opens the stock DetailPanel with the full question, the
// attachment list, the bot's answer and the Discord link.
// =============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import { DataGrid, DetailPanel, PanelTabBody, formatBytes, monoEl, mutedEl } from 'shell';
import type { ViewMenuEntry } from 'shell';
import type { GridColumnDefinition } from 'shell';
import type { ConversationRow, Outcome } from '../state/types';
import type { EvalCause, EvalEvent, EvalOutcome, RalphReplyType } from '../eval/rules';
import { sampleConversations } from '../sample';
import { discordLink, firstLine, formatWhen, idTitle, OUTCOME_LABEL, OUTCOME_TONE, OutcomeChip, reasonText, SampleBanner, shortId, Skeleton } from '../ui/parts';
import { Btn, Chip as DdChip, chipEl, DdBanner, DdCard, DdEmpty, ExtLink, PageHeader, questionEl, shortWhen, splitTag } from '../ui/dd';
import { Icon } from '../ui/Icon';
import { Thread } from '../ui/Thread';
import type { ScreenProps } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The outcome filter's vocabulary, in the order the spec lists it. */
const OUTCOME_OPTIONS = [
	{ value: '', label: 'All outcomes' },
	{ value: 'answered', label: 'Answered' },
	{ value: 'escalated', label: 'Escalated' },
	{ value: 'no_reply', label: 'No reply' },
	// A deliberate silence: the escalation pause, or a message aimed at someone
	// else. Its own filter entry because "show me what the bot ignored on purpose"
	// and "show me what it failed to answer" are different questions.
	{ value: 'quiet', label: 'Quiet' },
	{ value: 'error', label: 'Error' },
	{ value: 'pending', label: 'Waiting' },
];

/**
 * The eval outcomes in words.
 *
 * Local to this screen because the eval label is shown in ONE place (the side
 * panel) and nothing filters or sorts on it yet — a shared vocabulary can be
 * lifted out when the grader's own screen needs it too.
 */
const EVAL_OUTCOME_LABEL: Record<EvalOutcome, string> = {
	excluded: 'Excluded',
	deferred: 'Deferred — team answered',
	deferred_unanswered: 'Deferred — nobody answered',
	overridden: 'Overridden by the team',
	dead_end: 'Dead end',
	no_reply: 'No reply',
	rejected: 'Rejected by the asker',
	reasked: 'Re-asked',
	resolved_confirmed: 'Resolved — confirmed',
	resolved_unconfirmed: 'Resolved — unconfirmed',
};

/** The eval causes in words. */
const EVAL_CAUSE_LABEL: Record<EvalCause, string> = {
	tool_error: 'Tool error',
	engine_error: 'Engine error',
	policy_public: 'Policy — public channel',
	policy_account: 'Policy — account data',
	policy_other: 'Policy — other',
	product_defect: 'Product defect',
	feature_request: 'Feature request',
	content_gap: 'Documentation gap',
	bad_answer: 'Bad answer',
	retrieval_miss: 'Retrieval miss',
	unknown: 'Unknown',
};

/** What one reply the bot posted was, in words. */
const REPLY_CLASS_LABEL: Record<RalphReplyType, string> = {
	ralph_answer: 'Answer',
	escalation: 'Escalation',
	manipulation_flag: 'Manipulation flagged',
	dead_end: 'Dead end',
};

/** The drawer's two tabs: the thread to read, and every field to check. */
const DRAWER_TABS: ViewMenuEntry[] = [
	{ id: 'thread', label: 'Thread' },
	{ id: 'details', label: 'Details' },
];

/** Longest slice of an event's text shown in the compact log. */
const EVENT_TEXT_PREVIEW = 80;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * One line of the compact event log.
 *
 * `ts · type · actor · text`, the text clipped — the panel is a record of what
 * happened in the thread, not a second transcript of it. The emoji stands in
 * for the text on a reaction, which has none.
 *
 * @param event - One event from the row's log.
 * @returns The line.
 */
function eventLine(event: EvalEvent): string {
	const parts = [formatWhen(event.ts), event.type];
	if (event.actor_id != null && event.actor_id.length > 0) parts.push(event.actor_id);
	const detail = event.data?.emoji ?? event.text ?? event.data?.reason ?? null;
	if (detail != null && String(detail).length > 0) {
		parts.push(firstLine(String(detail), EVENT_TEXT_PREVIEW));
	}
	return parts.join(' · ');
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Conversations screen.
 *
 * @param props - See {@link ScreenProps}.
 * @returns The screen.
 */
export const ConversationsScreen: React.FC<ScreenProps> = ({ data, loaded, bot, sampleMode, ui, patchUi, goto, openKnowledgeSearch }) => {
	const now = Date.now();
	// The filter strip is a PREFERENCE, and the one piece of this screen that
	// is still persisted: it belongs to the person reading, not to the data,
	// so it stays in the workspace slice while the rows come from the
	// database.
	const filters = ui.conversationFilters;
	const setFilters = useCallback((next: Record<string, string | string[]>) => patchUi({ conversationFilters: next }), [patchUi]);
	const [openRow, setOpenRowState] = useState<ConversationRow | null>(null);
	const [drawerTab, setDrawerTab] = useState<'thread' | 'details'>('thread');
	// Every drawer opens on the thread.
	const setOpenRow = useCallback((row: ConversationRow | null) => {
		setOpenRowState(row);
		setDrawerTab('thread');
	}, []);

	const allRows = sampleMode ? sampleConversations(now) : data.conversations;

	// Newest first, then narrowed by the strip. The grid filters itself for its
	// own header popups; the strip's three filters are applied here so the
	// count in the header reflects what is on screen.
	const rows = useMemo(() => {
		const outcome = typeof filters.outcome === 'string' ? filters.outcome : '';
		const channel = typeof filters.channel === 'string' ? filters.channel.trim() : '';
		const since = typeof filters.since === 'string' ? filters.since : '';
		const sinceMs = since.length > 0 ? new Date(since).getTime() : 0;
		return allRows
			.slice()
			.sort((a, b) => b.seenAt - a.seenAt)
			.filter((row) => {
				if (outcome.length > 0 && row.outcome !== outcome) return false;
				if (channel.length > 0 && !(row.threadId ?? row.channelId).includes(channel)) return false;
				if (sinceMs > 0 && row.seenAt < sinceMs) return false;
				return true;
			});
	}, [allRows, filters]);

	const columns = useMemo(
		() =>
			[
				{
					title: 'Time',
					field: 'seenAt',
					rrType: 'date',
					rrDefault: true,
					rrDefaultSort: 'desc',
					rrDescription: 'When this app first saw an event for the message.',
					width: 130,
					headerSort: true,
					sorter: 'number',
					formatter: (cell) => {
						const el = mutedEl(shortWhen(cell.getValue() as number));
						el.title = formatWhen(cell.getValue() as number);
						return el;
					},
				},
				{
					title: 'Where',
					field: 'channelId',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'The thread the answer went to, or the channel when the bot answered in place.',
					width: 140,
					headerSort: true,
					// `thread …1421` / `channel …4442`: a full snowflake is unreadable
					// here and pushed the question off-screen. The tooltip and the
					// drawer carry it in full.
					formatter: (cell) => {
						const row = cell.getRow().getData() as ConversationRow;
						const id = row.threadId ?? row.channelId;
						const el = monoEl(shortId(row.threadId !== null ? 'thread' : 'channel', id));
						el.title = idTitle(id) ?? '';
						return el;
					},
				},
				{
					title: 'Asker',
					field: 'authorId',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'Display name when member metadata is on, otherwise the end of the user id (full id on hover).',
					width: 110,
					headerSort: true,
					formatter: (cell) => {
						const row = cell.getRow().getData() as ConversationRow;
						const el = row.authorName !== null ? mutedEl(row.authorName) : monoEl(shortId('user', row.authorId));
						el.title = idTitle(row.authorId) ?? '';
						return el;
					},
				},
				{
					title: 'Question',
					field: 'question',
					rrType: 'string',
					rrDefault: true,
					rrDescription: 'First line of the question as the events carried it.',
					headerSort: false,
					formatter: (cell) => {
						const row = cell.getRow().getData() as ConversationRow;
						// A test tag (`[eval R10] …`) becomes a mono tag, so the real
						// question reads first.
						const text = firstLine(String(cell.getValue() ?? ''));
						return questionEl(row.sample === true ? `Sample: ${text}` : text);
					},
				},
				{
					title: 'Outcome',
					field: 'outcome',
					rrType: 'enum',
					rrDefault: true,
					rrOptions: OUTCOME_OPTIONS.filter((o) => o.value.length > 0).map((o) => ({
						value: o.value,
						label: o.label,
					})),
					rrDescription: 'What the bot did: answered, escalated to the team role, left it alone on purpose (Quiet), failed to answer, or failed.',
					width: 136,
					headerSort: true,
					formatter: (cell) => {
						const outcome = String(cell.getValue() ?? 'pending') as Outcome;
						return chipEl(OUTCOME_TONE[outcome] ?? 'neutral', OUTCOME_LABEL[outcome] ?? outcome);
					},
				},
				{
					title: 'Reactions',
					field: 'reactions',
					rrType: 'strings',
					rrDefault: true,
					rrDescription: 'Emoji users added to the bot’s answer. Needs Emit Reactions on, or the eval-capture branch running — it emits them by design.',
					width: 120,
					headerSort: false,
					formatter: (cell) => {
						const list = cell.getValue();
						const emoji = Array.isArray(list) ? list.join(' ') : '';
						return mutedEl(emoji.length > 0 ? emoji : '—');
					},
				},
				{
					title: 'Attachments',
					field: 'attachments',
					rrType: 'json',
					rrDescription: 'Files that rode along with the question, shown as a count. Hidden by default.',
					width: 110,
					hozAlign: 'right',
					headerSort: false,
					formatter: (cell) => {
						const list = cell.getValue();
						return mutedEl(String(Array.isArray(list) ? list.length : 0));
					},
				},
				{
					title: 'Message id',
					field: 'id',
					rrType: 'string',
					rrDescription: 'The Discord message id, which is also the node’s correlation id. Hidden by default.',
					width: 190,
					headerSort: true,
					formatter: (cell) => monoEl(String(cell.getValue() ?? '')),
				},
			] satisfies GridColumnDefinition[],
		[]
	);

	// --- LOADING --------------------------------------------------------------

	const subtitle = 'Every question Ralph has seen, newest first.';

	if (!sampleMode && !loaded) {
		return (
			<div className="dd-page">
				<PageHeader title="Conversations" subtitle={subtitle} />
				<DdCard>
					<Skeleton rows={6} label="Loading captured conversations" />
				</DdCard>
			</div>
		);
	}

	// --- ERROR ----------------------------------------------------------------
	//
	// Nothing can be captured while no task is running, and saying "no questions
	// yet" then would be a lie about Discord rather than about this app.
	const captureDown = !sampleMode && bot.token === null;

	const panelHref = openRow !== null ? discordLink(openRow.guildId, openRow.threadId ?? openRow.channelId, openRow.id) : null;
	const outcomeValue = typeof filters.outcome === 'string' ? filters.outcome : '';
	const channelValue = typeof filters.channel === 'string' ? filters.channel : '';
	const sinceValue = typeof filters.since === 'string' ? filters.since : '';

	// The three filters, unchanged — outcome, channel or thread id, date — on
	// the list's own card, with the count on the right.
	const filterBar = (
		<div className="dd-filters" style={{ width: '100%' }}>
			<label className="dd-search">
				<Icon name="search" />
				<span className="dd-sr">Channel or thread</span>
				<input className="dd-input" type="text" placeholder="Channel or thread id contains…" value={channelValue} onChange={(e) => setFilters({ ...filters, channel: e.target.value })} />
			</label>
			<label>
				<span className="dd-sr">Outcome</span>
				<select className="dd-select" value={outcomeValue} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
					{OUTCOME_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</label>
			<label>
				<span className="dd-sr">On or after</span>
				<input className="dd-input" type="date" value={sinceValue} onChange={(e) => setFilters({ ...filters, since: e.target.value })} />
			</label>
			<span className="dd-spacer" />
			<span className="dd-caption dd-num">
				{rows.length} of {allRows.length}
			</span>
		</div>
	);

	return (
		<div className="dd-page" style={{ height: '100%', maxHeight: '100%', boxSizing: 'border-box' }}>
			<PageHeader title="Conversations" subtitle={subtitle} />
			{sampleMode && <SampleBanner />}

			{captureDown && (
				<DdBanner variant="warning" title="Capture pipeline not running.">
					Start the bot, or pick a different pipeline, and new questions will appear here as they arrive.
				</DdBanner>
			)}
			{captureDown && (
				<div className="dd-row">
					<Btn onClick={() => goto('settings', 'pipeline')}>Open Settings &rsaquo; Pipeline</Btn>
					<Btn variant="ghost" onClick={() => goto('bot')}>
						Go to Bot
					</Btn>
				</div>
			)}

			{/* One card: the filters on top, the table flush below. */}
			<div style={{ flex: 1, minHeight: 360, display: 'flex', flexDirection: 'column' }}>
				<DdCard toolbar={filterBar} flush fill>
					{rows.length === 0 ? <DdEmpty icon="message" title={allRows.length === 0 ? 'No conversations yet' : 'No questions match these filters'} description={allRows.length === 0 ? 'Ask a question in a support channel and it appears here within seconds, with what Ralph did about it.' : 'Clear a filter above to see the rest.'} action={allRows.length > 0 ? <Btn onClick={() => setFilters({})}>Clear filters</Btn> : undefined} /> : <DataGrid<ConversationRow> columns={columns} data={rows} tableId="discord-dashboard-conversations" paginate={false} height="100%" onRowClick={(row) => setOpenRow(row)} emptyTitle="No questions yet" emptyDescription="Post in #support to see the first one." />}
				</DdCard>
			</div>

			{/* --- The drawer: the thread first, every field on Details ---------- */}
			{openRow !== null && (
				<div className="dd-drawer-scope">
					<DetailPanel open onClose={() => setOpenRow(null)} title={splitTag(firstLine(openRow.question, 160)).rest || 'Captured question'} subtitle={`${shortId(openRow.threadId !== null ? 'thread' : 'channel', openRow.threadId ?? openRow.channelId)} · ${openRow.authorName ?? shortId('user', openRow.authorId)} · ${shortWhen(openRow.seenAt)}`} width={560} tabs={DRAWER_TABS} activeTab={drawerTab} onTabSelect={(id) => setDrawerTab(id as 'thread' | 'details')}>
						<PanelTabBody>
							{/* Head: the outcome and signal chips, and the way out to Discord. */}
							<div className="dd-row" style={{ padding: '10px 0 16px' }}>
								<OutcomeChip outcome={openRow.outcome} />
								{openRow.pagedSlack === true && <DdChip tone="brand">Paged Slack</DdChip>}
								{splitTag(openRow.question).tag !== null && <span className="dd-tag">{splitTag(openRow.question).tag}</span>}
								<span className="dd-spacer" />
								{/* The question, run through the same retrieval on the Knowledge
								    screen: the passages the knowledge base hands back for it. */}
								<Btn variant="ghost" small icon="search" onClick={() => openKnowledgeSearch(splitTag(openRow.question).rest || openRow.question)} disabled={sampleMode || openRow.question.trim().length === 0} title={sampleMode ? 'Turn off Sample data to search the knowledge base' : openRow.question.trim().length === 0 ? 'No question text was captured' : 'Search the knowledge base with this question, as Ralph retrieves'}>
									What Ralph retrieved
								</Btn>
								{panelHref !== null && <ExtLink href={panelHref}>Open in Discord</ExtLink>}
							</div>

							{drawerTab === 'thread' ? (
								<Thread row={openRow} />
							) : (
								<div className="dd-stack" style={{ gap: 20 }}>
									<dl className="dd-dl">
										<dt>Result</dt>
										<dd>
											<OutcomeChip outcome={openRow.outcome} />
										</dd>
										{/* The node's reason in words where the app knows them — a Quiet
										    row says nothing else about itself. An exception message is
										    shown verbatim. */}
										{reasonText(openRow.reason) !== null && (
											<>
												<dt>Reason</dt>
												<dd>{reasonText(openRow.reason)}</dd>
											</>
										)}
										{/* The one side effect of an answer its text does not show. */}
										{openRow.pagedSlack === true && (
											<>
												<dt>Slack</dt>
												<dd>
													<DdChip tone="brand">Paged Slack</DdChip>
												</dd>
											</>
										)}
										<dt>Question</dt>
										<dd style={{ whiteSpace: 'pre-wrap' }}>{openRow.question || '(no text captured for this message)'}</dd>
										<dt>Asker</dt>
										<dd className="dd-mono">{openRow.authorName ? `${openRow.authorName} · ${openRow.authorId}` : openRow.authorId || '—'}</dd>
										<dt>Seen</dt>
										<dd className="dd-num">{formatWhen(openRow.seenAt)}</dd>
										<dt>Channel</dt>
										<dd className="dd-mono">{openRow.channelId}</dd>
										{openRow.threadId !== null && (
											<>
												<dt>Thread</dt>
												<dd className="dd-mono">{openRow.threadId}</dd>
											</>
										)}
										<dt>Message id</dt>
										<dd className="dd-mono">{openRow.id}</dd>

										{/* --- The eval record: only where it exists. */}
										{openRow.evalOutcome != null && (
											<>
												<dt>Eval outcome</dt>
												<dd>
													{EVAL_OUTCOME_LABEL[openRow.evalOutcome]}
													{openRow.outcomeSource != null && ` · ${openRow.outcomeSource === 'review' ? 'reviewed' : 'decided by the rules'}`}
												</dd>
											</>
										)}
										{openRow.evalCause != null && (
											<>
												<dt>Cause</dt>
												<dd>
													{EVAL_CAUSE_LABEL[openRow.evalCause]}
													{openRow.causeSource != null && ` · ${openRow.causeSource === 'review' ? 'reviewed' : 'decided by the rules'}`}
												</dd>
											</>
										)}
										{openRow.excludedReason != null && (
											<>
												<dt>Excluded</dt>
												<dd>{openRow.excludedReason}</dd>
											</>
										)}
										{openRow.replyClass != null && (
											<>
												<dt>Reply class</dt>
												<dd>{REPLY_CLASS_LABEL[openRow.replyClass]}</dd>
											</>
										)}
										{(openRow.retries ?? 0) > 0 && (
											<>
												<dt>Retries</dt>
												<dd className="dd-num">{String(openRow.retries)}</dd>
											</>
										)}
										<dt>Attachments</dt>
										<dd>
											{openRow.attachments.length === 0 ? (
												<span className="dd-faint">None.</span>
											) : (
												<span className="dd-row" style={{ gap: 6 }}>
													{openRow.attachments.map((file, index) => (
														<span key={`${file.name ?? 'file'}-${index}`} className="dd-chip" title={file.name ?? 'unnamed'}>
															{`${file.name ?? 'unnamed'}${file.size !== null ? ` · ${formatBytes(file.size)}` : ''}`}
														</span>
													))}
												</span>
											)}
										</dd>
										<dt>Reactions</dt>
										<dd>
											{openRow.reactions.length === 0 ? (
												<span className="dd-faint">None captured.</span>
											) : (
												<span className="dd-reacts" style={{ marginTop: 0 }}>
													{openRow.reactions.map((emoji, index) => (
														<span key={`${emoji}-${index}`} className="dd-react">
															{emoji}
														</span>
													))}
												</span>
											)}
										</dd>
									</dl>

									{(openRow.events?.length ?? 0) > 0 && (
										<div className="dd-stack" style={{ gap: 8 }}>
											<span className="dd-eyebrow">Event log · {openRow.events?.length}</span>
											<ul className="dd-eventlog">
												{openRow.events?.map((event, index) => (
													<li key={`${event.type}-${event.message_id ?? index}`}>{eventLine(event)}</li>
												))}
											</ul>
										</div>
									)}
								</div>
							)}
						</PanelTabBody>
					</DetailPanel>
				</div>
			)}
		</div>
	);
};
