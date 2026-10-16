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
// REVIEW CARD — one thread, its verdict buttons and the teach editor
// =============================================================================
//
// The reference bot's `#ralph-eval` card, as a component: the same four head
// states, the same three rows of controls in the same order, and the same
// fields. Presentational only — every decision about WHAT a click writes lives
// in `src/eval/review.ts`, and every write is made by `ReviewTab`.
//
// Two departures from the Discord original, both forced and both deliberate:
//
// THE EMOJI ARE GONE from the titles and the lines. The words are the
// reference's; a Discord embed title leans on its emoji for the colour a card
// cannot show, and here the head state has a real badge.
//
// THE MODAL IS AN INLINE EDITOR. Discord made the teach form a modal because a
// modal is the only way to collect text from a button click there. In a screen
// an inline editor keeps the thread — the question, the grader's reasoning, the
// cause — on screen while the answer is being written, which is exactly the
// material somebody needs to write it.
// =============================================================================

import React from 'react';
import { CAUSE_LABELS, CAUSES, graderSummaryOf, headOf, headTitle, HEAD_LINE, issueUrlFor, KB_STATE_TEXT, kbStateOf, QUESTION_PREVIEW, reviewedLine, TEACH_FIELD_LIMIT, threadLink, VERDICT_BUTTONS, type ReviewVerdict } from '../../eval/review';
import type { EvalCause } from '../../eval/rules';
import type { ConversationRow } from '../../state/types';
import { Btn, Chip, DdCard, ExtLink, splitTag, type Tone } from '../../ui/dd';
import type { ReviewHead } from '../../eval/review';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The head chip per verdict state — the status language. */
const HEAD_CHIP: Record<ReviewHead, { tone: Tone; label: string }> = {
	miss: { tone: 'bad', label: 'Miss' },
	success: { tone: 'ok', label: 'Win' },
	pending: { tone: 'warn', label: 'Needs verdict' },
	excluded: { tone: 'neutral', label: 'Excluded' },
};

// =============================================================================
// TYPES
// =============================================================================

/** The teach editor's two fields. */
export interface TeachDraft {
	question: string;
	answer: string;
}

/** Props for {@link ReviewCard}. */
export interface ReviewCardProps {
	/** The row being reviewed. */
	row: ConversationRow;
	/** The cluster's label, or '—' when the row has none. */
	clusterLabel: string;
	/** A knowledge-base write is in flight for this row. */
	kbPending: boolean;
	/** A write of any kind is in flight for this row: every control waits. */
	busy: boolean;
	/** Why no control can act, or null. Sample mode, in practice. */
	disabledReason: string | null;
	/** Why the KB write cannot run, or null. Being disconnected, in practice. */
	teachDisabledReason: string | null;
	/** Whether the teach editor is open. */
	editing: boolean;
	/** The editor's current contents. */
	draft: TeachDraft;
	/** Fired on every keystroke in the editor. */
	onDraftChange: (draft: TeachDraft) => void;
	/** A verdict button was pressed. */
	onVerdict: (verdict: ReviewVerdict) => void;
	/** The cause select changed. */
	onCause: (cause: EvalCause) => void;
	/** Open the teach editor. */
	onOpenTeach: () => void;
	/** Close it without approving anything. */
	onCancelTeach: () => void;
	/** Approve the pair and run the KB write. */
	onSubmitTeach: () => void;
	/** Run the KB write again for a pair that never landed. */
	onRetryTeach: () => void;
	/** Open the Knowledge screen's meaning search for this question, or omit to hide the link. */
	onWhatRetrieved?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * One review card.
 *
 * @param props - See {@link ReviewCardProps}.
 * @returns The card.
 */
export const ReviewCard: React.FC<ReviewCardProps> = ({ row, clusterLabel, kbPending, busy, disabledReason, teachDisabledReason, editing, draft, onDraftChange, onVerdict, onCause, onOpenTeach, onCancelTeach, onSubmitTeach, onRetryTeach, onWhatRetrieved }) => {
	const head = headOf(row);
	const link = threadLink(row);
	const summary = graderSummaryOf(row);
	const kbState = kbStateOf(row, kbPending);
	const reviewed = reviewedLine(row);
	const qTop = row.grade?.qTopScore ?? null;
	const aTop = row.grade?.aTopScore ?? null;
	const blocked = disabledReason !== null || busy;
	// The cause select carries the row's cause as its value; a row with none sits
	// on the empty option so the select does not silently claim `tool_error`.
	const cause = row.evalCause ?? '';

	const chip = HEAD_CHIP[head];
	const question = row.question.slice(0, QUESTION_PREVIEW);
	const { tag, rest } = splitTag(question);

	return (
		<DdCard title={<span className="dd-eyebrow">{headTitle(row)}</span>} actions={<Chip tone={chip.tone}>{chip.label}</Chip>}>
			<div className="dd-stack" style={{ gap: 14 }}>
				<p className="dd-help">{HEAD_LINE[head]}</p>

				<div className="dd-row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 16 }}>
					<p className="dd-reviewq">
						{tag !== null && <span className="dd-tag">{tag}</span>}
						{rest || '(no text captured)'}
					</p>
					<span className="dd-spacer" />
					{onWhatRetrieved !== undefined && (
						<Btn variant="ghost" small icon="search" onClick={onWhatRetrieved} disabled={disabledReason !== null} title={disabledReason ?? 'Search the knowledge base with this question, as Ralph retrieves'}>
							What Ralph retrieved
						</Btn>
					)}
					{link !== null && <ExtLink href={link}>Open in Discord</ExtLink>}
				</div>

				<dl className="dd-dl">
					<dt>Cluster</dt>
					<dd>
						{clusterLabel === '—' ? (
							'—'
						) : (
							<Chip tone="neutral" icon={null}>
								{clusterLabel}
							</Chip>
						)}
					</dd>
					{/* DISTANCES, not similarities: `eval-retrieve.pipe` ends in Chroma
					    and Chroma's score is a distance, so lower is closer. The label
					    says so, because "match 0.91" reads as a good match and is not. */}
					<dt>q/a distance</dt>
					<dd className="dd-num">{`${qTop === null ? '—' : qTop.toFixed(2)} question · ${aTop === null ? '—' : aTop.toFixed(2)} answer`}</dd>
					<dt>Why (grader)</dt>
					<dd>{summary ?? '—'}</dd>
					{kbState !== null && row.qaApproved != null && (
						<>
							<dt>Answer taught</dt>
							<dd>
								{`by ${row.qaApproved.approvedBy} — ${KB_STATE_TEXT[kbState]}`}
								{kbState === 'not_reached' && (
									<>
										{' '}
										<Btn variant="ghost" small onClick={onRetryTeach} disabled={blocked || teachDisabledReason !== null} title={teachDisabledReason ?? 'Send the approved answer to the knowledge base again'}>
											Retry the KB write
										</Btn>
									</>
								)}
							</dd>
						</>
					)}
					{reviewed !== null && (
						<>
							<dt>Reviewed</dt>
							<dd className="dd-muted">{reviewed}</dd>
						</>
					)}
				</dl>

				{/* The teach editor. Prefilled from the grader's draft where it made
				    one — it only drafts when the TEAM supplied the answer, so the
				    answer box is legitimately empty much of the time, and the question
				    always falls back to the thread's own. */}
				{editing && (
					<div className="dd-editor">
						<label className="dd-stack" style={{ gap: 6 }}>
							<span className="dd-field__label">Question (what users ask)</span>
							<textarea className="dd-input" rows={2} maxLength={TEACH_FIELD_LIMIT} value={draft.question} disabled={busy} onChange={(e) => onDraftChange({ ...draft, question: e.target.value })} />
						</label>
						<label className="dd-stack" style={{ gap: 6 }}>
							<span className="dd-field__label">Answer — Ralph reuses this on similar Qs</span>
							<textarea className="dd-input" rows={6} maxLength={TEACH_FIELD_LIMIT} placeholder="Write the answer Ralph should have given." value={draft.answer} disabled={busy} onChange={(e) => onDraftChange({ ...draft, answer: e.target.value })} />
						</label>
						<div className="dd-row">
							<Btn variant="primary" small icon="book" onClick={onSubmitTeach} disabled={busy || disabledReason !== null || teachDisabledReason !== null || draft.question.trim().length === 0 || draft.answer.trim().length === 0} title={disabledReason ?? teachDisabledReason ?? (draft.answer.trim().length === 0 ? 'Write the answer first' : 'Approve this pair and add it to Ralph’s knowledge base')}>
								{busy ? 'Adding to the KB…' : 'Approve and teach'}
							</Btn>
							<Btn variant="ghost" small onClick={onCancelTeach} disabled={busy}>
								Cancel
							</Btn>
							<span className="dd-caption">Both fields hold up to {TEACH_FIELD_LIMIT} characters. Approving also seeds a golden case for test runs.</span>
						</div>
					</div>
				)}

				{/* The decision, as one row: the verdict, the reason, and the two
				    follow-ups. The issue is a LINK; the app never files one. */}
				<div className="dd-card__foot dd-reviewfoot">
					<div className="dd-btngroup" role="group" aria-label="Verdict">
						{VERDICT_BUTTONS[head].map((button) => (
							<button key={button.verdict} type="button" className="dd-btn dd-btn--sm" onClick={() => onVerdict(button.verdict)} disabled={blocked} title={disabledReason ?? undefined}>
								{button.label}
							</button>
						))}
					</div>
					<label>
						<span className="dd-sr">{head === 'pending' ? 'If it was a miss, set the reason' : 'Change the reason it missed'}</span>
						<select
							className="dd-select dd-select--sm"
							value={cause}
							disabled={blocked}
							title={head === 'pending' ? 'If it was a miss, set the reason…' : 'Change the reason it missed…'}
							onChange={(e) => {
								const next = e.target.value;
								if (next.length > 0) onCause(next as EvalCause);
							}}
						>
							<option value="">(no reason set)</option>
							{CAUSES.map((entry) => (
								<option key={entry} value={entry}>
									{CAUSE_LABELS[entry].slice(0, 100)}
								</option>
							))}
						</select>
					</label>
					<span className="dd-spacer" />
					<ExtLink href={issueUrlFor(row.question)}>File a GitHub issue</ExtLink>
					<Btn variant="primary" small icon="book" onClick={onOpenTeach} disabled={blocked || editing} title={disabledReason ?? 'Write the answer Ralph should have given'}>
						Teach Ralph the answer
					</Btn>
				</div>
			</div>
		</DdCard>
	);
};
