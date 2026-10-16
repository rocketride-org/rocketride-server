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
// SHARED PARTS — the pieces every screen needs
// =============================================================================
//
// Skeletons for the loading cell of the state matrix, the sample-data banner
// for the read-only cell, the outcome badge vocabulary, and the small
// formatters. Everything else composes stock shell components directly.
// =============================================================================

import React from 'react';
import { StatusBadge } from 'shell';
import type { StatusVariant } from 'shell';
import type { Outcome, SeedStatus } from '../state/types';
import { Chip, DdBanner, type Tone } from './dd';

// =============================================================================
// STYLES
// =============================================================================

// =============================================================================
// SKELETON
// =============================================================================

/**
 * Placeholder bars for a block whose data has not arrived yet.
 *
 * `aria-hidden` plus a sibling live line: the bars are decoration, the word
 * "Loading" is what a screen reader should get.
 *
 * @param props.rows - How many bars to draw. Default 3.
 * @param props.label - What is loading, announced to assistive tech.
 * @returns The skeleton block.
 */
export const Skeleton: React.FC<{ rows?: number; label: string }> = ({ rows = 3, label }) => (
	<div>
		<span className="dd-sr" role="status">
			{label}
		</span>
		<div className="dd-skel" aria-hidden="true">
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="dd-skel__bar" style={{ width: `${100 - i * 12}%` }} />
			))}
		</div>
	</div>
);

// =============================================================================
// SAMPLE BANNER
// =============================================================================

/**
 * The read-only-mode banner. Rendered at the top of every screen while
 * Settings › Advanced has Sample data on, so no screen can silently show
 * invented rows as if they were live.
 *
 * @returns The banner.
 */
export const SampleBanner: React.FC = () => (
	<DdBanner variant="warning" title="Sample data is on.">
		Every row on this screen is made up, and the bot actions are disabled. Turn it off in Settings &rsaquo; Advanced to work with the real bot.
	</DdBanner>
);

// =============================================================================
// VOCABULARY
// =============================================================================

/** Badge label per outcome — the words the UX spec uses. */
export const OUTCOME_LABEL: Record<Outcome, string> = {
	pending: 'Waiting',
	answered: 'Answered',
	escalated: 'Escalated',
	no_reply: 'No reply',
	quiet: 'Quiet',
	error: 'Error',
};

/**
 * Badge variant per outcome — the UX spec's status colour table: success is
 * resolved, warning needs a human, error failed, info is in progress, muted
 * is out of scope.
 */
export const OUTCOME_VARIANT: Record<Outcome, StatusVariant> = {
	pending: 'info',
	answered: 'success',
	escalated: 'warning',
	// A question nobody answered is a failure; "Quiet" is the bot correctly
	// keeping out, which is out of scope rather than bad.
	no_reply: 'error',
	quiet: 'muted',
	error: 'error',
};

/**
 * The node's `no_reply` reason strings, in words.
 *
 * The node's own vocabulary is short and mechanical; anything not in this map is
 * an exception message and is shown verbatim, because the node's text is the
 * best explanation that exists for a failure.
 */
const REASON_LABEL: Record<string, string> = {
	no_answer: 'The pipeline produced no answer.',
	non_answer: 'The reply was not an answer, so it was suppressed (Reply hygiene).',
	paused: 'This thread was already escalated — the bot stays quiet until it is @mentioned again.',
	aimed_elsewhere: 'The message was aimed at someone else, so the bot left it alone.',
};

/**
 * One `no_reply` reason, in words where the app knows them.
 *
 * @param reason - The node's reason string.
 * @returns The sentence to show, or null when there is no reason.
 */
export function reasonText(reason: string | null): string | null {
	if (reason === null || reason.length === 0) return null;
	return REASON_LABEL[reason] ?? reason;
}

/** Badge label per replay verdict. */
export const SEED_LABEL: Record<SeedStatus, string> = {
	pass: 'Pass',
	fail: 'Fail',
	hard_fail: 'Hard fail',
};

/** Badge variant per replay verdict. A fail is a failure, not a hand-off. */
export const SEED_VARIANT: Record<SeedStatus, StatusVariant> = {
	pass: 'success',
	fail: 'error',
	hard_fail: 'error',
};

/** The design system's tone per outcome — the same meanings as {@link OUTCOME_VARIANT}. */
export const OUTCOME_TONE: Record<Outcome, Tone> = {
	pending: 'info',
	answered: 'ok',
	escalated: 'warn',
	no_reply: 'bad',
	quiet: 'neutral',
	error: 'bad',
};

/**
 * The outcome as a design-system status chip: glyph and word.
 *
 * @param props.outcome - What the bot did with the question.
 * @returns The chip.
 */
export const OutcomeChip: React.FC<{ outcome: Outcome }> = ({ outcome }) => <Chip tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Chip>;

/**
 * The outcome badge.
 *
 * @param props.outcome - What the bot did with the question.
 * @returns The badge.
 */
export const OutcomeBadge: React.FC<{ outcome: Outcome }> = ({ outcome }) => <StatusBadge variant={OUTCOME_VARIANT[outcome]}>{OUTCOME_LABEL[outcome]}</StatusBadge>;

// =============================================================================
// FORMATTERS
// =============================================================================

/**
 * Render a Unix-ms stamp as a short local time, or a dash when absent.
 *
 * @param ms - Unix milliseconds, or 0 / undefined for "unknown".
 * @returns A short local date and time.
 */
export function formatWhen(ms: number | undefined): string {
	if (!ms) return '—';
	const d = new Date(ms);
	return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Render how long ago something happened, in the coarsest unit that still
 * says something useful.
 *
 * @param ms - Unix milliseconds, or 0 / undefined for "unknown".
 * @param now - The current time in Unix ms.
 * @returns A phrase such as "4 min ago".
 */
export function formatAge(ms: number | undefined, now: number): string {
	if (!ms) return '—';
	const seconds = Math.max(0, Math.round((now - ms) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

/**
 * The first line of a question, clipped for a table cell.
 *
 * @param text - The full question text.
 * @param limit - Maximum characters. Default 120.
 * @returns One line, ellipsised when clipped.
 */
export function firstLine(text: string, limit = 120): string {
	const line = text.split('\n')[0]?.trim() ?? '';
	if (line.length <= limit) return line;
	return `${line.slice(0, limit - 1)}…`;
}

/**
 * A Discord id shortened for a list: `user …2363`.
 *
 * Full snowflakes are unreadable in a grid and push the question off-screen;
 * the full id stays in the tooltip ({@link idTitle}) and in the detail drawer.
 *
 * @param kind - What the id names (`user`, `channel`, `thread`), or '' for none.
 * @param id - The snowflake, or null.
 * @returns `kind …last4`, or a dash when there is no id.
 */
export function shortId(kind: string, id: string | null | undefined): string {
	if (!id) return '—';
	const tail = id.length > 4 ? `…${id.slice(-4)}` : id;
	return kind ? `${kind} ${tail}` : tail;
}

/**
 * The tooltip that carries a shortened id in full.
 *
 * @param id - The snowflake, or null.
 * @returns The id, or undefined so no empty tooltip is rendered.
 */
export function idTitle(id: string | null | undefined): string | undefined {
	return id ? id : undefined;
}

/**
 * A Discord deep link for one message, when the ids allow one.
 *
 * Discord message URLs are `/channels/<guild>/<channel>/<message>`; without a
 * guild id there is no addressable link, so the caller renders plain text.
 *
 * @param guildId - The server id.
 * @param channelId - The channel (or thread) id the message lives in.
 * @param messageId - The message id.
 * @returns The URL, or null when it cannot be built.
 */
export function discordLink(guildId: string | null, channelId: string, messageId: string): string | null {
	if (!guildId || !channelId || !messageId) return null;
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
