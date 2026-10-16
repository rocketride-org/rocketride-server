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
// EVAL RULES SELF-TEST — the reference bot's own unit tests, as a function
// =============================================================================
//
// The app has no unit-test runner (it is a shell bundle, not a package with a
// test script), and the rules it just inherited are the one part of the eval
// loop where a silent drift would relabel real support traffic. So the
// reference's `tests/eval/rules.test.ts` is ported case for case into a pure
// function that returns its failures.
//
// Nothing calls it yet, by design: wiring it into a screen or a build step is a
// later stage's decision. It is here so that "the rules still agree with the
// reference" is one call away and reviewable in the diff.
//
// The one deliberate difference from the reference file: the escalation-marker
// adaptation (Ping The Team On Escalation off, so the reply says "Escalated to
// the RocketRide team." and pings nobody) gets a case of its own at the end —
// there is nothing in the reference to port for it.
// =============================================================================

import { analyzeRetrieval, classifyRalphReply, DEAD_END_REPLY, decideCause, decideOutcome, isTeamMember, roleMentionOf, roundInterval, wilson, type EvalEvent, type EvalOutcome, type GraderSignals, type ThreadInfo } from './rules';

// =============================================================================
// HELPERS
// =============================================================================

/** The reference's fixture role mention. */
const ROLE = '<@&999>';

/** The reference's fixture thread: a non-team opener in channel c1. */
const U: ThreadInfo = { opener_id: 'usr', opener_is_team: false, channel_id: 'c1' };

/** One event, the reference's terse fixture form. */
const ev = (type: string, ts: number, extra: Partial<EvalEvent> = {}): EvalEvent => ({ type, ts, ...extra });

// =============================================================================
// API
// =============================================================================

/**
 * Run every ported case.
 *
 * @returns One message per failing assertion; empty when the port still agrees
 *          with the reference.
 */
export function runRulesSelfTest(): string[] {
	const failures: string[] = [];

	/** Assert two scalars are equal. */
	const eq = (name: string, actual: unknown, expected: unknown): void => {
		if (actual !== expected) failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`);
	};

	/** Assert two intervals are equal (or both null). */
	const eqInterval = (name: string, actual: [number, number] | null, expected: [number, number] | null): void => {
		const same = actual === expected || (actual !== null && expected !== null && actual[0] === expected[0] && actual[1] === expected[1]);
		if (!same) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	};

	/** The outcome of one fixture thread. */
	const outcome = (thread: ThreadInfo, events: EvalEvent[], g: GraderSignals = {}, opts: { testAllowBotIds?: string[]; testChannelIds?: string[] } = {}): EvalOutcome => decideOutcome(thread, events, g, opts).outcome;

	// --- classifyRalphReply ---------------------------------------------------

	eq('classifyRalphReply: dead end', classifyRalphReply(DEAD_END_REPLY, ROLE, DEAD_END_REPLY).type, 'dead_end');

	eq('classifyRalphReply: manipulation flag', classifyRalphReply(`${ROLE} — heads up, someone just asked me to comment on an issue`, ROLE, DEAD_END_REPLY).type, 'manipulation_flag');

	const github = classifyRalphReply(`I ran into an issue reaching GitHub — let me bring in the ${ROLE}`, ROLE, DEAD_END_REPLY);
	eq('classifyRalphReply: github tool escalation type', github.type, 'escalation');
	eq('classifyRalphReply: github tool escalation reason', github.reason, 'tool_github');

	const http = classifyRalphReply(`I ran into an issue loading that page — ${ROLE}`, ROLE, DEAD_END_REPLY);
	eq('classifyRalphReply: http tool escalation type', http.type, 'escalation');
	eq('classifyRalphReply: http tool escalation reason', http.reason, 'tool_http');

	const plain = classifyRalphReply(`Sorry, I can't answer — let me bring in the ${ROLE}`, ROLE, DEAD_END_REPLY);
	eq('classifyRalphReply: plain escalation type', plain.type, 'escalation');
	eq('classifyRalphReply: plain escalation reason', plain.reason, null);

	eq('classifyRalphReply: @RocketRide team text', classifyRalphReply('bringing in the @RocketRide team', ROLE, DEAD_END_REPLY).type, 'escalation');

	eq('classifyRalphReply: normal answer', classifyRalphReply('You can use `pip install rocketride`', ROLE, DEAD_END_REPLY).type, 'ralph_answer');

	// --- wilson ---------------------------------------------------------------

	eqInterval('wilson: 18/20', roundInterval(wilson(18, 20)), [0.699, 0.972]);
	eqInterval('wilson: 72/80', roundInterval(wilson(72, 80)), [0.815, 0.948]);
	eq('wilson: empty sample', wilson(0, 0), null);

	// --- isTeamMember ---------------------------------------------------------

	eq('isTeamMember: by role', isTeamMember(['ROLE1'], 'u1', 'ROLE1', []), true);
	eq('isTeamMember: by explicit id', isTeamMember([], 'u2', 'ROLE1', ['u2']), true);
	eq('isTeamMember: neither', isTeamMember([], 'u3', 'ROLE1', []), false);

	// --- decideOutcome --------------------------------------------------------

	eq('decideOutcome: excluded internal', decideOutcome({ ...U, opener_is_team: true }, [ev('question', 1)]).excluded_reason, 'internal');
	eq('decideOutcome: excluded test channel', decideOutcome(U, [ev('question', 1)], {}, { testChannelIds: ['c1'] }).excluded_reason, 'test');
	eq('decideOutcome: deferred', outcome(U, [ev('question', 1), ev('escalation', 2), ev('team_reply', 3)]), 'deferred');
	eq('decideOutcome: deferred_unanswered', outcome(U, [ev('question', 1), ev('escalation', 2)]), 'deferred_unanswered');
	eq('decideOutcome: overridden', outcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('team_reply', 3)], { team_reply_kind: 'correction' }), 'overridden');
	eq('decideOutcome: dead_end', outcome(U, [ev('question', 1), ev('dead_end', 2)]), 'dead_end');
	eq('decideOutcome: no_reply (nothing posted)', outcome(U, [ev('question', 1)]), 'no_reply');
	eq('decideOutcome: rejected', outcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('reaction_add', 3, { actor_id: 'usr', data: { emoji: '❌' } })]), 'rejected');
	eq('decideOutcome: resolved_confirmed', outcome(U, [ev('question', 1), ev('ralph_answer', 2), ev('reaction_add', 3, { actor_id: 'usr', data: { emoji: '✅' } })]), 'resolved_confirmed');
	eq('decideOutcome: resolved_unconfirmed', outcome(U, [ev('question', 1), ev('ralph_answer', 2)]), 'resolved_unconfirmed');

	// --- decideCause ----------------------------------------------------------

	eq('decideCause: tool error', decideCause('deferred', [ev('escalation', 1, { data: { reason: 'tool_github' } })]), 'tool_error');
	eq('decideCause: engine error', decideCause('no_reply', [ev('no_reply', 1)]), 'engine_error');
	eq('decideCause: policy category', decideCause('deferred', [ev('escalation', 1)], { escalation_category: 'policy_account' }), 'policy_account');

	/** The reference's retrieval fixture. */
	const r = (aTop: number | null, overlap: boolean) => ({ aTop, overlap, teamAnswerExists: true, matchScore: 0.7 });
	eq('decideCause: content gap', decideCause('overridden', [], {}, r(0.4, false)), 'content_gap');
	eq('decideCause: bad answer', decideCause('overridden', [], {}, r(0.9, true)), 'bad_answer');
	eq('decideCause: retrieval miss', decideCause('overridden', [], {}, r(0.9, false)), 'retrieval_miss');
	eq('analyzeRetrieval: no team answer score', analyzeRetrieval(null, false, 0.7), 'content_gap');
	eq('decideCause: null for successes', decideCause('resolved_confirmed', []), null);

	// --- The app's own adaptations --------------------------------------------

	eq('classifyRalphReply: configured escalation marker (no role ping)', classifyRalphReply('I cannot see account state from here. Escalated to the RocketRide team.', '', DEAD_END_REPLY, ['Escalated to the RocketRide team.']).type, 'escalation');
	eq('classifyRalphReply: marker absent, no ping, plain answer', classifyRalphReply('Save it as a server variable.', '', DEAD_END_REPLY, ['Escalated to the RocketRide team.']).type, 'ralph_answer');
	eq('roleMentionOf: configured role', roleMentionOf(' 999 '), ROLE);
	eq('roleMentionOf: no role configured', roleMentionOf(''), '');

	return failures;
}
