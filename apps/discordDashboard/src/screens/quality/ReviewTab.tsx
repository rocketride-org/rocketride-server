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
// QUALITY › REVIEW — the queue of graded threads, one card each
// =============================================================================
//
// This is what replaces the reference bot's `#ralph-eval` channel: the same
// cards, the same verdicts and the same teach flow, in the app. It owns the
// STATE and the WRITES; `ReviewCard` renders one row and `src/eval/review.ts`
// decides what each control means.
//
// WHO IS REVIEWING is the signed-in shell user (`useAuthUser`), cached on first
// sight so the name a card records cannot change halfway through a session. Team
// gating is the app manifest's `authenticated: true` and nothing else: the
// reference checked a Discord role because anyone could click a button in a
// public channel, and here being able to open the app IS the permission. There
// is no role check to make.
//
// A VERDICT IS A DATABASE WRITE, and a shared one: the verdict, its audit row
// in `dd_reviews` and the approved Q/A all land in Postgres, so the reviewer
// who decided a thread and the one who opens it ten minutes later see the
// same decision. Two things follow. A verdict now needs the DATABASE (it used
// to need nothing — it was a workspace write), and the knowledge-base write
// still needs the ENGINE on top of that, which is why it keeps a disabled
// reason of its own and why a pair approved while the KB was unreachable
// shows "not marked as reaching the KB" with a retry rather than being lost.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { useAuthUser, useShellConnection } from 'shell';
import type { AuthUser } from 'shell';
import { CAUSE_LABELS, goldenCaseFor, matchesReviewFilters, needsFreshPair, patchForVerdict, reviewQueue, REVIEW_FILTERS, verdictNote, type ReviewFilterId, type ReviewVerdict } from '../../eval/review';
import { describeTeachResult, teachApproved } from '../../eval/teach';
import type { EvalCause } from '../../eval/rules';
import type { ApprovedQa } from '../../db/repo';
import type { DashboardActions } from '../../db/useDashboardData';
import type { AppData, ConversationRow } from '../../state/types';
import { SampleBanner } from '../../ui/parts';
import { DdBanner, DdCard, DdEmpty, FilterChip, PageHeader, splitTag } from '../../ui/dd';
import { useToast } from '../../ui/toast';
import { ReviewCard, type TeachDraft } from './ReviewCard';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * What a review is attributed to when the shell has no identity for the user.
 *
 * Never a guess at a name: an anonymous review is still a review by a person who
 * could open the app, and "reviewer" says exactly as much as is known.
 */
export const FALLBACK_REVIEWER = 'reviewer';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link ReviewTab}. */
export interface ReviewTabProps {
	/** Everything the screens render. */
	data: AppData;
	/** The database writes. Every verdict goes through them. */
	actions: DashboardActions;
	/** The approved pairs the knowledge-base write still owes. */
	pendingQa: ApprovedQa[];
	/** Sample data is on: the cards render, nothing can be written. */
	sampleMode: boolean;
	/** Why a write cannot run, or null. */
	writesBlocked: string | null;
	/** The filter chips that are on — a UI preference the app root holds. */
	filters: string[];
	/** Set them. */
	onFiltersChange: (filters: string[]) => void;
	/** The Quality tabs, rendered under the page header. */
	nav?: React.ReactNode;
	/** Open the Knowledge screen's meaning search for a question ("What Ralph retrieved"). */
	onWhatRetrieved?: (question: string) => void;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The name to record a review under, out of the shell's identity.
 *
 * Display name first, then the email, then the user id — the same order the
 * shell's own account surfaces use. Null when the identity has not arrived yet,
 * which the caller treats as "keep what you had".
 *
 * @param identity - What `useAuthUser` returned.
 * @returns The name, or null.
 */
export function reviewerNameOf(identity: AuthUser | null): string | null {
	if (identity === null) return null;
	const candidates = [identity.displayName, identity.email, identity.userId];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
	}
	return null;
}

/**
 * The editor's starting contents for one row.
 *
 * A FRESH pair starts from the grader's draft — which exists only when a team
 * member supplied the answer, so the answer box is legitimately blank much of
 * the time, and the question always falls back to the thread's own. An approved
 * pair that has not reached the KB yet starts from what the reviewer wrote, so
 * reopening the editor is an edit rather than a retype.
 *
 * @param row - The row.
 * @returns The draft.
 */
export function teachDraftFor(row: ConversationRow): TeachDraft {
	if (!needsFreshPair(row) && row.qaApproved != null) {
		return { question: row.qaApproved.question, answer: row.qaApproved.answer };
	}
	return {
		question: row.qaDraft?.question ?? row.question,
		answer: row.qaDraft?.answer ?? '',
	};
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Review tab.
 *
 * @param props - See {@link ReviewTabProps}.
 * @returns The tab.
 */
export const ReviewTab: React.FC<ReviewTabProps> = ({ data, actions, pendingQa, sampleMode, writesBlocked, filters: storedFilters, onFiltersChange, nav, onWhatRetrieved }) => {
	const toast = useToast();
	const { client, isConnected } = useShellConnection();
	const identity = useAuthUser();

	// The stored chips, narrowed: a preference read back as a chip that no
	// longer exists would filter everything out.
	const filters = useMemo(() => storedFilters.filter((id): id is ReviewFilterId => REVIEW_FILTERS.some((entry) => entry.id === id)), [storedFilters]);
	const [reviewer, setReviewer] = useState(FALLBACK_REVIEWER);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, TeachDraft>>({});
	// One row at a time: the writeback runs are serialised anyway, and two cards
	// mid-write would let a reviewer approve a pair while its own write is
	// deciding whether it landed.
	const [busyId, setBusyId] = useState<string | null>(null);
	const [kbPendingId, setKbPendingId] = useState<string | null>(null);
	// Rows touched in THIS sitting, kept on screen whatever the chips say. The
	// reference edited its card in place after a click; a card that vanished the
	// instant it was decided would take the "Reviewed" line with it — and would
	// take a teach submit's whole KB-state sequence (adding… → in Ralph's KB) off
	// screen before any of it happened.
	const [justReviewed, setJustReviewed] = useState<string[]>([]);

	// Cached on first sight, and never allowed back to the fallback: the shell's
	// identity arrives after the first render, and a name that changed mid-session
	// would attribute two halves of one sitting to two different people.
	useEffect(() => {
		const name = reviewerNameOf(identity);
		if (name !== null) setReviewer(name);
	}, [identity]);

	const queue = useMemo(() => reviewQueue(data.conversations), [data.conversations]);
	const shown = useMemo(() => queue.filter((row) => justReviewed.includes(row.id) || matchesReviewFilters(row, filters)), [queue, filters, justReviewed]);
	const clusters = data.quality.clusters ?? [];

	/** Why nothing can be written, or null. */
	const blockedReason = sampleMode ? 'Turn off Sample data to review real rows' : writesBlocked;

	/** Why the knowledge-base write cannot run, or null. */
	const teachBlockedReason = blockedReason ?? (!isConnected || !client ? 'Not connected to the engine — the KB write cannot run' : null);

	// --- Verdicts -------------------------------------------------------------

	/** Keep a row on screen for the rest of the sitting. */
	function pin(rowId: string): void {
		setJustReviewed((prev) => (prev.includes(rowId) ? prev : [...prev, rowId]));
	}

	/** Apply one verdict button. */
	function handleVerdict(row: ConversationRow, verdict: ReviewVerdict): void {
		if (blockedReason !== null) return;
		const patch = patchForVerdict(row, verdict);
		const note = verdictNote(row, verdict);
		// Optimistic in the UI and confirmed by the reload the action does: the
		// card is pinned and the note shown now, and a failed write says so.
		pin(row.id);
		void actions
			.applyReview(row.id, patch, reviewer, verdict)
			.then(() => toast.success(note))
			.catch((err: unknown) => {
				toast.error(`Could not save the verdict: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	/** Set the cause from the select. */
	function handleCause(row: ConversationRow, cause: EvalCause): void {
		if (blockedReason !== null) return;
		pin(row.id);
		void actions
			.applyReview(row.id, { cause }, reviewer, 'cause')
			.then(() => toast.success(`Reason set to ${CAUSE_LABELS[cause]}.`))
			.catch((err: unknown) => {
				toast.error(`Could not save the reason: ${err instanceof Error ? err.message : String(err)}`);
			});
	}

	// --- Teaching -------------------------------------------------------------

	/**
	 * Run the knowledge-base write for the pairs still owed one.
	 *
	 * `pending` is passed in rather than read from the prop, because the
	 * approval that makes a pair eligible was written moments ago and the
	 * reload that would surface it has not necessarily rendered yet — the
	 * caller re-reads it from the database instead.
	 */
	async function runWriteback(rowId: string, pending: ApprovedQa[]): Promise<void> {
		if (!client || teachBlockedReason !== null) return;
		setBusyId(rowId);
		setKbPendingId(rowId);
		try {
			const result = await teachApproved({
				client,
				pending,
				settings: data.settings,
				markIngested: actions.markQaIngested,
			});
			const line = describeTeachResult(result, rowId);
			if (result.error !== null || !result.ingested.includes(rowId)) toast.error(line);
			else toast.success(line);
		} catch (err) {
			toast.error(`The KB write failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusyId(null);
			setKbPendingId(null);
		}
	}

	/** Approve the edited pair, seed its golden case, then write it to the KB. */
	async function handleSubmitTeach(row: ConversationRow): Promise<void> {
		if (blockedReason !== null) return;
		const draft = drafts[row.id] ?? teachDraftFor(row);
		const question = draft.question.trim();
		const answer = draft.answer.trim();
		if (question.length === 0 || answer.length === 0) return;

		const golden = goldenCaseFor(row, question, answer, Date.now());

		setEditingId(null);
		pin(row.id);
		let approved: ApprovedQa;
		try {
			// One transaction, for the reason the one write had: the approved pair,
			// its golden case and the review stamp are one decision, and a reload
			// landing between them would leave a taught answer with no case to
			// prove it keeps working.
			approved = await actions.teach(row.id, { question, answer }, golden, reviewer);
		} catch (err) {
			toast.error(`Could not approve the Q/A: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		toast.success(`Q/A approved (golden: ${golden.expected}). Adding it to Ralph’s KB…`);

		if (teachBlockedReason !== null) {
			toast.error(`${teachBlockedReason}. The pair stays approved — retry from the card.`);
			return;
		}
		// The pair just approved is in the database but not yet in this render's
		// `pendingQa`, so it is substituted in — the way the old code substituted
		// the conversation row it had just written.
		await runWriteback(row.id, [...pendingQa.filter((pair) => pair.id !== approved.id && pair.threadId !== row.id), approved]);
	}

	// --- LOADING / EMPTY ------------------------------------------------------

	const draftFor = (row: ConversationRow): TeachDraft => drafts[row.id] ?? teachDraftFor(row);

	return (
		<div className="dd-page">
			{/* The explainer paragraph is the page subtitle now. */}
			<PageHeader title="Quality" subtitle="Confirm or correct the grader, and teach Ralph the answers he missed. Every graded thread, newest activity first: a verdict decides whether it counts as a win or a miss on the Scorecard, and the reason explains a miss without changing it." />
			{nav}
			{sampleMode && <SampleBanner />}

			<div className="dd-row">
				{REVIEW_FILTERS.map((entry) => (
					<FilterChip key={entry.id} pressed={filters.includes(entry.id)} onClick={() => onFiltersChange(filters.includes(entry.id) ? filters.filter((id) => id !== entry.id) : [...filters, entry.id])}>
						{entry.label}
					</FilterChip>
				))}
				<span className="dd-spacer" />
				<span className="dd-caption dd-num" title="Rows you have already reviewed are hidden until the Reviewed chip is on.">
					{shown.length} of {queue.length} · reviewing as <strong className="dd-strong">{reviewer}</strong>
				</span>
			</div>

			{/* ERROR-adjacent state: the one thing a reviewer cannot do offline,
			    said once at the top rather than on every card. */}
			{blockedReason === null && teachBlockedReason !== null && <DdBanner variant="warning">{teachBlockedReason}. Verdicts and reasons still save; teaching Ralph an answer needs the engine.</DdBanner>}

			{queue.length === 0 ? (
				<DdCard>
					<DdEmpty icon="check" title="Nothing to review" description="Grade the captured conversations on the Test tab first — a thread reaches this queue once the grader has labelled it." />
				</DdCard>
			) : shown.length === 0 ? (
				<DdCard>
					<DdEmpty icon="search" title="No thread matches these filters" description="Turn a chip on above — Reviewed shows the threads that have already been decided." />
				</DdCard>
			) : (
				shown.map((row) => (
					<ReviewCard
						key={row.id}
						row={row}
						clusterLabel={clusters.find((cluster) => cluster.id === (row.grade?.clusterId ?? ''))?.label ?? (row.grade?.clusterId != null && row.grade.clusterId.length > 0 ? `#${row.grade.clusterId}` : '—')}
						kbPending={kbPendingId === row.id}
						busy={busyId === row.id}
						disabledReason={blockedReason}
						teachDisabledReason={teachBlockedReason}
						editing={editingId === row.id}
						draft={draftFor(row)}
						onDraftChange={(draft) => setDrafts((prev) => ({ ...prev, [row.id]: draft }))}
						onVerdict={(verdict) => handleVerdict(row, verdict)}
						onCause={(cause) => handleCause(row, cause)}
						onOpenTeach={() => {
							setDrafts((prev) => ({ ...prev, [row.id]: prev[row.id] ?? teachDraftFor(row) }));
							setEditingId(row.id);
						}}
						onCancelTeach={() => setEditingId(null)}
						onSubmitTeach={() => void handleSubmitTeach(row)}
						onRetryTeach={() => void runWriteback(row.id, pendingQa)}
						onWhatRetrieved={onWhatRetrieved !== undefined && row.question.trim().length > 0 ? () => onWhatRetrieved(splitTag(row.question).rest || row.question) : undefined}
					/>
				))
			)}
		</div>
	);
};
