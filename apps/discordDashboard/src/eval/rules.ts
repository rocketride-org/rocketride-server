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
// EVAL RULES — the support bot's own labelling logic, ported verbatim
// =============================================================================
//
// PURE functions, no imports, no I/O. This is a port of the reference bot's
// `eval/rules.ts` (the standalone discord.js support bot): the same names, the
// same regexes, the same first-match-wins order, so a row labelled by this app
// and a row labelled by the bot's own grader carry the same label.
//
// The three names that could not travel unchanged, and why:
//
// - `Outcome` → {@link EvalOutcome}. The app already has an `Outcome` (what the
//   bot DID with a question: pending / answered / escalated / …), and the eval
//   outcome is a different axis entirely (whether the answer was GOOD). Keeping
//   both names would be one import away from a silent mix-up.
// - `Cause` → {@link EvalCause}, for symmetry with the above.
// - `EvalEvent.data` is a typed bag rather than `any`, because this app compiles
//   under `strict` and the reference's `e.data?.emoji` reads are the whole of
//   what `data` is used for. The fields are the reference's own keys.
//
// Three behavioural adaptations. The first two are because the app configures
// the bot where the reference read the environment — see
// {@link classifyRalphReply} and {@link DEAD_END_REPLY}. The third is the
// retrieval SIGN: this app's retrieve pipe returns a Chroma distance where the
// reference's returned a similarity, so {@link analyzeRetrievalDistance} sits
// beside the untouched {@link analyzeRetrieval} and {@link decideCause} takes
// either threshold.
// =============================================================================

// =============================================================================
// REPLY CLASSIFICATION
// =============================================================================

/** What one reply the bot posted was. */
export type RalphReplyType = 'ralph_answer' | 'escalation' | 'manipulation_flag' | 'dead_end';

/** Why an escalation happened, when the reply says so. */
export type EscReason = 'tool_github' | 'tool_http' | null;

/** The classification of one posted reply. */
export interface ReplyClass {
	type: RalphReplyType;
	reason?: EscReason;
}

// Escalation phrasings from the agent instructions in the shipped prompts
// (`discord-ralph.pipe`, `resolvePipeline`) — stable enough to regex.
const RE_MANIPULATION = /heads up, someone just asked me to/i;
const RE_TOOL_GITHUB = /issue reaching GitHub/i;
const RE_TOOL_HTTP = /issue loading that page/i;
const RE_TEAM_TEXT = /@RocketRide\s+team/i;

/**
 * The literal canned fallback the bot posts when a part errors or times out.
 *
 * ADAPTATION (a): the reference read this from `eval/config.ts`, which read the
 * bot's environment. The app has no equivalent setting, so the reference's
 * literal is the default every caller gets.
 */
export const DEAD_END_REPLY = 'Sorry — I could not process that.';

/**
 * The `<@&role>` mention a configured team role id produces.
 *
 * @param teamRoleId - `settings.discord.teamRoleId`, possibly empty.
 * @returns The mention string, or '' when no role is configured (which
 *          {@link classifyRalphReply} then ignores, exactly as the reference's
 *          empty `ROLE_MENTION` did).
 */
export function roleMentionOf(teamRoleId: string): string {
	const id = teamRoleId.trim();
	return id.length > 0 ? `<@&${id}>` : '';
}

/**
 * Classify a reply the bot posted.
 *
 * ADAPTATION (b): the reference recognised an escalation by the resolved role
 * mention or the literal `@RocketRide team` text. This app also accepts any of
 * the user's configured `behavior.escalationMarkers`, because the shipped
 * prompts end an escalation with the plain line "Escalated to the RocketRide
 * team." whenever Ping The Team On Escalation is off — which is the default, so
 * without this the commonest escalation in the app would read as an answer.
 * The extra argument is optional and defaults to none, so a call with the
 * reference's three arguments behaves exactly as the reference does.
 *
 * @param reply - The text the bot posted.
 * @param roleMention - The resolved `<@&role>` string, or '' for none.
 * @param deadEndReply - The canned fallback; '' disables the test.
 * @param escalationMarkers - Reply text the user declared to be an escalation.
 * @returns The classification, with `reason` on an escalation.
 */
export function classifyRalphReply(reply: string, roleMention: string, deadEndReply: string, escalationMarkers: string[] = []): ReplyClass {
	const r = (reply ?? '').trim();
	if (deadEndReply && r === deadEndReply.trim()) return { type: 'dead_end' };
	const marked = escalationMarkers.some((marker) => {
		const m = marker.trim();
		return m.length > 0 && r.includes(m);
	});
	const escalated = (roleMention && r.includes(roleMention)) || RE_TEAM_TEXT.test(r) || marked;
	if (escalated) {
		if (RE_MANIPULATION.test(r)) return { type: 'manipulation_flag' };
		let reason: EscReason = null;
		if (RE_TOOL_GITHUB.test(r)) reason = 'tool_github';
		else if (RE_TOOL_HTTP.test(r)) reason = 'tool_http';
		return { type: 'escalation', reason };
	}
	return { type: 'ralph_answer' };
}

/**
 * A responder counts as team if they carry the escalation role OR are in the
 * explicit id list.
 *
 * @param roleIds - The author's role ids (empty unless member metadata is on).
 * @param userId - The author's id.
 * @param escalationRoleId - The configured team role id.
 * @param teamUserIds - Team members without the role.
 * @returns Whether this responder is on the team.
 */
export function isTeamMember(roleIds: string[], userId: string, escalationRoleId: string, teamUserIds: string[]): boolean {
	if (teamUserIds.includes(userId)) return true;
	return !!escalationRoleId && roleIds.includes(escalationRoleId);
}

// =============================================================================
// STATISTICS
// =============================================================================

/**
 * Wilson score interval.
 *
 * @param successes - Successes observed.
 * @param n - Trials.
 * @param z - Standard score; 1.96 is the 95% interval.
 * @returns `[low, high]` in [0,1], or null when `n <= 0`.
 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
	if (n <= 0) return null;
	const p = successes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Round a `[lo,hi]` interval for display and tests (null-safe).
 *
 * @param iv - The interval, or null.
 * @param dp - Decimal places. Default 3.
 * @returns The rounded interval, or null.
 */
export function roundInterval(iv: [number, number] | null, dp = 3): [number, number] | null {
	if (!iv) return null;
	const f = 10 ** dp;
	return [Math.round(iv[0] * f) / f, Math.round(iv[1] * f) / f];
}

// =============================================================================
// OUTCOME + CAUSE
// =============================================================================
//
// The escalation-success refinement is DEFERRED in the reference and stays
// deferred here: for now every escalation is a failure.

/** The ten eval outcomes one thread can end in. */
export type EvalOutcome = 'excluded' | 'deferred' | 'deferred_unanswered' | 'overridden' | 'dead_end' | 'no_reply' | 'rejected' | 'reasked' | 'resolved_confirmed' | 'resolved_unconfirmed';

/** Why a failing thread failed. */
export type EvalCause = 'tool_error' | 'engine_error' | 'policy_public' | 'policy_account' | 'policy_other' | 'product_defect' | 'feature_request' | 'content_gap' | 'bad_answer' | 'retrieval_miss' | 'unknown';

/**
 * The keys an event's `data` can carry.
 *
 * The reference typed this `any` and stored it as a JSON column; the named keys
 * here are the ones it actually wrote, and the index signature keeps the bag
 * open for the later stages.
 */
export interface EvalEventData {
	/** `reaction_add` / `reaction_remove`: the emoji. */
	emoji?: string;
	/** `escalation`: why. `no_reply`: the node's reason string. */
	reason?: string | null;
	/** `reaction_*`: the message that was reacted TO. */
	target_message_id?: string | null;
	/** A bot reply: every chunk id the node posted. */
	message_ids?: string[];
	/** A bot reply: `reply` | `channel` | `thread` | `suppressed`. */
	destination?: string | null;
	/** A retried text pass's ordinal, from the node's `retry` payload key. */
	retry?: number;
	[key: string]: unknown;
}

/**
 * One thing that happened in a thread.
 *
 * `message_id` and `text` are the reference's own `events` table columns; they
 * are optional here because a synthetic event (a no-reply, a Slack page) has no
 * message of its own.
 */
export interface EvalEvent {
	type: string;
	actor_id?: string | null;
	ts: number;
	data?: EvalEventData;
	message_id?: string | null;
	text?: string | null;
}

/** The thread-level facts the decision needs. */
export interface ThreadInfo {
	opener_id: string;
	opener_is_team: boolean;
	channel_id?: string;
}

/** What a later grading stage adds to the event log. */
export interface GraderSignals {
	team_reply_kind?: 'none' | 'ack' | 'correction' | 'addition';
	user_signal?: 'confirmed' | 'rejected' | 'neutral';
	escalation_category?: 'policy_public' | 'policy_account' | 'policy_other' | 'knowledge' | null;
	llm_cause?: 'product_defect' | 'feature_request' | null;
}

const FAILURES = new Set<EvalOutcome>(['deferred', 'deferred_unanswered', 'overridden', 'dead_end', 'no_reply', 'rejected', 'reasked']);

/** Whether an outcome counts against the target. */
export const isFailure = (o: EvalOutcome): boolean => FAILURES.has(o);

/** Whether an outcome is out of the denominator entirely. */
export const isExcluded = (o: EvalOutcome): boolean => o === 'excluded';

/**
 * Latest ✅/❌ reaction added by the opener.
 *
 * @param events - The thread's events.
 * @param openerId - Who asked.
 * @returns The last verdict emoji, or null.
 */
function latestOpenerReaction(events: EvalEvent[], openerId: string): '✅' | '❌' | null {
	let r: '✅' | '❌' | null = null;
	for (const e of events) {
		const emoji = e.data?.emoji;
		if (e.type === 'reaction_add' && e.actor_id === openerId && (emoji === '✅' || emoji === '❌')) r = emoji;
	}
	return r;
}

/**
 * Label one thread from its event log. First match wins, in this order.
 *
 * A `no_reply` event is treated exactly as the reference treated it, which is
 * how this app's dead-end-class evidence arrives: the node emits `no_reply` with
 * reason `non_answer` (the sanitizer dropped a non-answer) or `no_answer` (the
 * pipeline returned nothing) where the reference bot called
 * `recordNoReply('model_error' | 'empty')`.
 *
 * @param thread - Thread-level facts.
 * @param events - The event log, any order.
 * @param g - Grader signals, when a grader has run.
 * @param opts - Test bots and test channels to exclude.
 * @returns The outcome, plus `excluded_reason` when excluded.
 */
export function decideOutcome(thread: ThreadInfo, events: EvalEvent[], g: GraderSignals = {}, opts: { testAllowBotIds?: string[]; testChannelIds?: string[] } = {}): { outcome: EvalOutcome; excluded_reason?: string } {
	const ev = [...events].sort((a, b) => a.ts - b.ts);
	// excluded
	if (thread.opener_is_team) return { outcome: 'excluded', excluded_reason: 'internal' };
	if ((opts.testAllowBotIds ?? []).includes(thread.opener_id) || (opts.testChannelIds ?? []).includes(thread.channel_id ?? '')) return { outcome: 'excluded', excluded_reason: 'test' };
	if (ev.some((e) => e.type === 'manipulation_flag')) return { outcome: 'excluded', excluded_reason: 'manipulation' };

	const escIdx = ev.findIndex((e) => e.type === 'escalation');
	const hasEsc = escIdx >= 0;
	const teamReplyAfterEsc = hasEsc && ev.slice(escIdx + 1).some((e) => e.type === 'team_reply');
	const hasTeamReply = ev.some((e) => e.type === 'team_reply');
	const ralphEvents = ev.filter((e) => ['ralph_answer', 'escalation', 'manipulation_flag', 'dead_end', 'no_reply'].includes(e.type));
	const lastRalph = ralphEvents[ralphEvents.length - 1];
	const reaction = latestOpenerReaction(ev, thread.opener_id);

	// failures (first match wins)
	if (hasEsc && teamReplyAfterEsc) return { outcome: 'deferred' };
	if (hasEsc && !teamReplyAfterEsc) return { outcome: 'deferred_unanswered' };
	if (hasTeamReply && !hasEsc && (g.team_reply_kind === 'correction' || g.team_reply_kind === 'addition')) return { outcome: 'overridden' };
	if (lastRalph?.type === 'dead_end') return { outcome: 'dead_end' };
	if (!lastRalph || lastRalph.type === 'no_reply') return { outcome: 'no_reply' };
	if (reaction === '❌' || g.user_signal === 'rejected') return { outcome: 'rejected' };
	// successes
	if (reaction === '✅' || g.user_signal === 'confirmed') return { outcome: 'resolved_confirmed' };
	return { outcome: 'resolved_unconfirmed' };
}

/**
 * Retrieval analysis.
 *
 * @param aTop - Top retrieval score for the team-answer text.
 * @param overlap - A top chunk was already in the question's retrieval.
 * @param matchScore - The score above which the KB counts as holding it.
 * @returns The cause the scores imply.
 */
export function analyzeRetrieval(aTop: number | null, overlap: boolean, matchScore: number): EvalCause {
	if (aTop == null || aTop < matchScore) return 'content_gap'; // ← the KB doesn't have it: a DOC GAP
	if (overlap) return 'bad_answer'; // the bot had it in context and still failed
	return 'retrieval_miss'; // it's in the KB but retrieval didn't surface it
}

/**
 * The same analysis over a DISTANCE rather than a similarity.
 *
 * ADAPTATION (c), the retrieval SIGN. The reference's retrieval pipe returned a
 * similarity, so "the KB holds this" was `score >= matchScore` and the top hit
 * was the MAXIMUM. The app's `eval-retrieve.pipe` returns Chroma's own number,
 * which is a DISTANCE: lower is closer, a real docs question tops out around
 * 0.78 and nonsense sits around 0.91. So the top hit is the MINIMUM and the test
 * flips to `aTop <= matchDistance`.
 *
 * {@link analyzeRetrieval} is left exactly as the reference wrote it — a caller
 * with a similarity score still gets the reference's behaviour, and the ported
 * self-test still describes real semantics. This function is the one the app's
 * own grader calls, and the three outcomes it can return are the reference's
 * three, unchanged:
 *
 * - no team answer near anything in the KB → `content_gap` (a DOC GAP)
 * - a team answer in the KB whose top chunk the question already retrieved →
 *   `bad_answer` (the bot had it in context and still failed)
 * - a team answer in the KB that the question's retrieval did not surface →
 *   `retrieval_miss`
 *
 * @param aTop - Smallest distance for the team-answer text, or null when the
 *        retrieval returned nothing at all.
 * @param overlap - A chunk within `matchDistance` of the team answer was also
 *        within `matchDistance` of the question.
 * @param matchDistance - The distance at or below which the KB counts as holding
 *        the answer (`settings.eval.matchDistance`).
 * @returns The cause the distances imply.
 */
export function analyzeRetrievalDistance(aTop: number | null, overlap: boolean, matchDistance: number): EvalCause {
	if (aTop == null || aTop > matchDistance) return 'content_gap';
	if (overlap) return 'bad_answer';
	return 'retrieval_miss';
}

/**
 * Why a thread failed. Null for anything that is not a failure.
 *
 * @param outcome - The decided outcome.
 * @param events - The event log.
 * @param g - Grader signals, when a grader has run.
 * @param retrieval - Retrieval scores, when a retrieval pass has run. Exactly one
 *        threshold is given: `matchDistance` for the app's own retrieval pipe
 *        (ADAPTATION (c) — see {@link analyzeRetrievalDistance}) or `matchScore`
 *        for the reference's similarity scores. `matchDistance` wins when both
 *        are present; with neither, the KB cannot be judged and the failure reads
 *        as a `content_gap`, exactly as a retrieval that returned nothing does.
 * @returns The cause, or null.
 */
export function decideCause(
	outcome: EvalOutcome,
	events: EvalEvent[],
	g: GraderSignals = {},
	retrieval?: {
		aTop: number | null;
		overlap: boolean;
		teamAnswerExists: boolean;
		matchScore?: number;
		matchDistance?: number;
	}
): EvalCause | null {
	if (!isFailure(outcome)) return null;
	const esc = events.find((e) => e.type === 'escalation');
	if (esc?.data?.reason === 'tool_github' || esc?.data?.reason === 'tool_http') return 'tool_error';
	if (outcome === 'dead_end' || outcome === 'no_reply') return 'engine_error';
	if ((outcome === 'deferred' || outcome === 'deferred_unanswered') && g.escalation_category && g.escalation_category !== 'knowledge') return g.escalation_category as EvalCause;
	if (g.llm_cause === 'product_defect' || g.llm_cause === 'feature_request') return g.llm_cause;
	if (retrieval && retrieval.teamAnswerExists) {
		return retrieval.matchDistance !== undefined ? analyzeRetrievalDistance(retrieval.aTop, retrieval.overlap, retrieval.matchDistance) : analyzeRetrieval(retrieval.aTop, retrieval.overlap, retrieval.matchScore ?? Number.POSITIVE_INFINITY);
	}
	return 'unknown';
}
