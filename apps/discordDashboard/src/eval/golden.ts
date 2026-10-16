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
// GOLDEN SET — the ten seeds a replay holds the bot to, plus what review taught
// =============================================================================
//
// The reference bot kept `replay-seeds.md` as a markdown table that NO CODE
// READ: the ten questions had to be typed back in through the CLI before a
// replay could use them, and a fresh checkout therefore had an empty golden set
// and a replay that did nothing. This module is that table VENDORED as data, so
// the app ships with a runnable regression set on first open.
//
// The source of truth is `nodes/test/discord/live/replay_seeds.md`. Each row's
// "A correct answer should…" note becomes the {@link GoldenCase.goldenAnswer}
// the judge scores the reply against — it is a rubric rather than a model answer,
// which is exactly how the reference used it (the judge prompt asks about
// SUBSTANCE, not wording).
//
// EVERY SEED EXPECTS AN ANSWER. Rows 5 to 8 read "… else escalate → <team>" and
// row 4 names Hiring as the escalation route, but in all five the escalation is
// the FALLBACK: the note's first clause is "give the known fix / the grant / the
// guidance". `expected: 'escalate'` would therefore hard-fail the bot for doing
// the right thing. An `escalate` case only enters the set from the Review tab,
// where a human labelled the cause as one that needs a person
// (`goldenCaseFor` in `review.ts`).
//
// The set a run actually uses is {@link goldenSet}: these seeds, with whatever
// the teach flow has added on top.
// =============================================================================

import type { GoldenCase } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The stamp the vendored seeds carry.
 *
 * The date on the seed table ("As of 2026-09-22"), not `Date.now()`: these cases
 * are a fixture, and a `createdAt` that moved on every page load would make the
 * set look freshly authored on every open.
 */
const SEEDED_AT = Date.UTC(2026, 8, 22);

/**
 * One vendored row, before it becomes a {@link GoldenCase}.
 *
 * `topic` is the seed table's own column. It is not part of `GoldenCase` (the
 * reference's `golden_cases` table has no such column) and is kept here only so
 * the vendored data stays readable beside the source file.
 */
interface SeedRow {
	/**
	 * `R01` … `R10`, in table order.
	 *
	 * The ids the rest of the toolchain already uses for these ten questions:
	 * `nodes/test/discord/live/replay_seeds.md`, `test_replay.py` and the runs in
	 * `.context/replay-runs`. A regression is keyed on the case id, so a run from
	 * the harness and a run driven here have to agree on it or every seed looks
	 * new.
	 */
	id: string;
	/** The question, verbatim from the table. */
	question: string;
	/** The table's Topic column. Documentation only. */
	topic: string;
	/** The table's "A correct answer should…" note — the judge's rubric. */
	goldenAnswer: string;
}

/**
 * The ten rows of `nodes/test/discord/live/replay_seeds.md`.
 *
 * Markdown emphasis is dropped from the notes (`**not**` → "not") because the
 * note is sent to the judge as prose, not rendered; the backticked identifiers
 * are kept, since they are the literal names the answer has to get right.
 */
const SEED_ROWS: SeedRow[] = [
	{
		id: 'R01',
		question: 'How do I get started with RocketRide?',
		topic: 'onboarding',
		goldenAnswer: 'Point to the VS Code extension, building a `.pipe`, running locally vs. Cloud, and `npm/pip install rocketride` — a concrete quickstart, not vague.',
	},
	{
		id: 'R02',
		question: 'Does RocketRide work with Python 3.10?',
		topic: 'version fact',
		goldenAnswer: 'State the actually-supported Python version(s) from the docs. Must not guess a version.',
	},
	{
		id: 'R03',
		question: 'How much does RocketRide Cloud cost?',
		topic: 'pricing',
		goldenAnswer: 'Fetch cloud.rocketride.ai/pricing; list Starter/Builder/Pro/Team/Enterprise plus the token model and $0.03/token overage; end with the pricing link.',
	},
	{
		id: 'R04',
		question: 'I applied for a role — how do I get the 500 free Cloud tokens for the app challenge?',
		topic: 'hiring grant',
		goldenAnswer: 'Explain the applicant grant (redeem promo/QR code, no card, 30-day expiry) from the policy doc; link pricing; an escalation here routes to Hiring (Josh/Joe/Ben), not Ops/Coupon.',
	},
	{
		id: 'R05',
		question: 'My Cloud API key (rr_…) gets a 403 on the WebSocket upgrade at api.rocketride.ai — why?',
		topic: 'cloud (tricky)',
		goldenAnswer: 'Give the known cause/fix from the FAQ; if unresolved, escalate to Cloud.',
	},
	{
		id: 'R06',
		question: "The public Docker engine image (ghcr.io/rocketride-org/rocketride-engine:latest) won't start — how do I fix it?",
		topic: 'deps/infra (tricky)',
		goldenAnswer: 'Give the known fix from the FAQ; else escalate to Deps/Infra.',
	},
	{
		id: 'R07',
		question: "I built custom nodes but they show as blank boxes on the canvas (and the FalkorDB node isn't available) — how do I fix it?",
		topic: 'nodes',
		goldenAnswer: 'Give node-availability / build guidance; else escalate to Integration.',
	},
	{
		id: 'R08',
		question: "Local mode can't connect — the engine exits during startup (code=1). Help?",
		topic: 'engine (local)',
		goldenAnswer: "Give local-engine troubleshooting; escalate to Engine (NOT Cloud — it's local).",
	},
	{
		id: 'R09',
		question: 'For the webhook source node, can I send mixed data types (video, audio, and text) in one request?',
		topic: 'capability',
		goldenAnswer: "Answer correctly about multimodal webhook handling; don't invent constraints.",
	},
	{
		id: 'R10',
		question: 'Can I build a document-uploader + chatbot in the same pipeline? Show me the `.pipe`.',
		topic: 'pipeline schema (critical)',
		goldenAnswer: 'Emit CORRECT current schema: top-level `components` (never `nodes`), profile-nested config, `response_answers`, LLM attached via a `control` edge. Guards the known corpus-poison regression.',
	},
];

// =============================================================================
// THE VENDORED SET
// =============================================================================

/**
 * The ten seed cases, in table order.
 *
 * `threadId` is empty: these cases came from a curated table, not from a thread
 * the app captured, and `seedGoldenCase`'s thread dedupe (in `review.ts`) must
 * not see them as one thread's ten cases. `source: 'manual'` is the reference's
 * own label for a case entered by hand rather than taught from a review.
 */
export const DEFAULT_GOLDEN: GoldenCase[] = SEED_ROWS.map((row) => ({
	id: row.id,
	question: row.question,
	expected: 'answer',
	goldenAnswer: row.goldenAnswer,
	source: 'manual',
	threadId: '',
	active: true,
	createdAt: SEEDED_AT,
}));

/** The seed table's Topic column, by case id — for a tooltip, never for scoring. */
export const SEED_TOPICS: Record<string, string> = Object.fromEntries(SEED_ROWS.map((row) => [row.id, row.topic]));

// =============================================================================
// MERGE
// =============================================================================

/** A question, reduced to what "the same question" means. */
function normalizeQuestion(question: string): string {
	return question.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The golden set a run uses: the vendored seeds plus what review taught.
 *
 * Inactive stored cases are dropped (`active: false` is the reference's soft
 * delete). A stored case REPLACES a seed IN PLACE when they share an id or ask
 * the same question, for two reasons: a reviewer approved that answer against a
 * real thread, so it is the fresher rubric; and replacing rather than appending
 * keeps the question from being asked — and paid for — twice in one run.
 *
 * @param stored - `quality.golden`, or undefined on a slice that has none.
 * @returns The active set: seeds first, then the taught cases, oldest first.
 */
export function goldenSet(stored: GoldenCase[] | undefined): GoldenCase[] {
	const taught = (stored ?? []).filter((entry) => entry.active);
	const byId = new Map(taught.map((entry) => [entry.id, entry]));
	const byQuestion = new Map(taught.map((entry) => [normalizeQuestion(entry.question), entry]));

	const used = new Set<string>();
	const seeds = DEFAULT_GOLDEN.map((seed) => {
		const override = byId.get(seed.id) ?? byQuestion.get(normalizeQuestion(seed.question));
		if (override === undefined) return seed;
		used.add(override.id);
		return override;
	});
	return [...seeds, ...taught.filter((entry) => !used.has(entry.id))];
}
