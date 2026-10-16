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
// SAMPLE DATA — the demo / read-only cell of the state matrix
// =============================================================================
//
// Settings › Advanced › Sample data renders these rows instead of the live
// ones, with every action disabled and a banner saying so. They exist so the
// screens can be reviewed and demoed without a Discord server, and every row
// carries `sample: true` so nothing here can be mistaken for real traffic.
//
// Nothing in this file talks to the engine. Timestamps are relative to load
// time so the ages read sensibly whenever the app is opened.
// =============================================================================

import type { ConversationRow, ReplayRun, SeedResult } from './state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** One minute in ms, for readable relative stamps. */
const MINUTE = 60_000;

/** The made-up server the sample rows pretend to come from. */
export const SAMPLE_GUILD_ID = '000000000000000001';

/** The made-up support channel. */
export const SAMPLE_CHANNEL_ID = '000000000000000002';

/** The bot identity the sample status header shows. */
export const SAMPLE_BOT_NAME = 'Rocket Ralph (sample)';

// =============================================================================
// CONVERSATIONS
// =============================================================================

/**
 * Sample conversation rows, newest last (the live list's order).
 *
 * @param now - Unix ms to anchor the relative stamps to.
 * @returns Five rows, one per outcome: answered, escalated, quiet, no reply and
 *          error.
 */
export function sampleConversations(now: number): ConversationRow[] {
	const row = (index: number, minutesAgo: number, rest: Partial<ConversationRow> & Pick<ConversationRow, 'question' | 'outcome'>): ConversationRow => ({
		id: `sample-${index}`,
		seenAt: now - minutesAgo * MINUTE,
		channelId: SAMPLE_CHANNEL_ID,
		guildId: SAMPLE_GUILD_ID,
		threadId: null,
		authorId: `sample-author-${index}`,
		authorName: null,
		correlationId: `sample-${index}`,
		answer: null,
		reason: null,
		attachments: [],
		reactions: [],
		updatedAt: now - minutesAgo * MINUTE,
		sample: true,
		...rest,
	});

	return [
		row(4, 190, {
			question: 'Does the parse node handle password-protected PDFs?',
			outcome: 'error',
			authorName: 'sample-user-4',
			reason: 'openai: request timed out after 60s',
		}),
		row(3, 96, {
			question: 'gm',
			outcome: 'no_reply',
			authorName: 'sample-user-3',
			reason: 'no_answer',
		}),
		// Quiet: the bot had already escalated in this thread, so it stayed out of
		// it. Never on "Needs you" — that is the point of the outcome.
		row(5, 52, {
			question: '@sample-user-2 any update on that key?',
			outcome: 'quiet',
			authorName: 'sample-user-5',
			threadId: '000000000000000012',
			reason: 'paused',
		}),
		row(2, 38, {
			question: 'Our workspace key stopped working this morning — can someone check the account?',
			outcome: 'escalated',
			authorName: 'sample-user-2',
			threadId: '000000000000000012',
			answer: 'I cannot see account state from here, so I am escalating this. <@&000000000000000099> can you take a look?',
		}),
		row(1, 6, {
			question: 'How do I pass an OpenAI key to a pipeline without putting it in the .pipe file?',
			outcome: 'answered',
			authorName: 'sample-user-1',
			threadId: '000000000000000011',
			answer: 'Save it as a server variable and reference it as ${ROCKETRIDE_OPENAI_KEY} in the pipe. The server substitutes it at start, so the key never rides in the file.',
			reactions: ['✅'],
			attachments: [{ name: 'my-pipeline.pipe', size: 4210 }],
		}),
	];
}

// =============================================================================
// QUALITY
// =============================================================================

/** Sample seed results — one regression against the previous run. */
const SAMPLE_SEEDS: SeedResult[] = [
	{ id: 'seed-01', question: 'What is a lane?', status: 'pass', verdict: 'correct', notes: 'Names the four media lanes.' },
	{ id: 'seed-02', question: 'How do I deploy an app?', status: 'pass', verdict: 'correct', notes: 'Covers deploy then publish.' },
	{
		id: 'seed-03',
		question: 'Which node writes rows to Postgres?',
		status: 'hard_fail',
		verdict: 'invented a node',
		notes: 'Claimed a db_postgres write mode. No catalog node inserts rows.',
	},
	{ id: 'seed-04', question: 'What does ttl 0 mean?', status: 'pass', verdict: 'correct', notes: 'Runs until stopped.' },
	{
		id: 'seed-05',
		question: 'Can the bot add reactions?',
		status: 'fail',
		verdict: 'hedged',
		notes: 'Did not say the node cannot post reactions.',
	},
];

/** The same seeds as they graded on the previous run — seed-05 passed then. */
const SAMPLE_PREVIOUS_SEEDS: SeedResult[] = SAMPLE_SEEDS.map((seed) => (seed.id === 'seed-05' ? { ...seed, status: 'pass', verdict: 'correct', notes: 'Said the node cannot post reactions.' } : seed));

/**
 * A sample pair of replay runs, so the Quality screen can show a regression
 * badge without an import.
 *
 * @param now - Unix ms to anchor the import stamps to.
 * @returns The last run and the one before it.
 */
export function sampleQuality(now: number): { lastRun: ReplayRun; previousRun: ReplayRun } {
	return {
		lastRun: {
			importedAt: now - 30 * MINUTE,
			fileName: 'sample-test-latest.jsonl',
			seeds: SAMPLE_SEEDS,
		},
		previousRun: {
			importedAt: now - 7 * 24 * 60 * MINUTE,
			fileName: 'sample-test-previous.jsonl',
			seeds: SAMPLE_PREVIOUS_SEEDS,
		},
	};
}
