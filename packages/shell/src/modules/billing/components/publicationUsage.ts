// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Served by publication: the pure half of the Billing pane's publication
 * breakdown (plan 8.3, B39; mockup 4.3).
 *
 * The server answers one row per publication (pipe, rung, answering team,
 * version) from the VIEWER's own org rows; this module fixes the reporting
 * period the pane asks for and turns those rows into the grid's display
 * rows. No React, no DOM, so a node test covers it.
 */

import type { PublicationUsage } from '../types';

// =============================================================================
// TYPES
// =============================================================================

/** A reporting period: the ISO bounds sent to the server and its display label. */
export interface UsagePeriod {
	/** First UTC day counted (ISO, midnight UTC). */
	since: string;
	/** First UTC day not counted (ISO, midnight UTC). */
	until: string;
	/** Display label, e.g. "November 2026". */
	label: string;
}

/** One row of the served-by-publication grid. */
export interface PublicationRow extends Record<string, unknown> {
	/** Stable row identity: pipe, rung, team and version together. */
	id: string;
	/** Published pipe name, `developerId.pipeId`. */
	publication: string;
	/** Version label (`v4`), or `--` for a development run. */
	version: string;
	/** Who answered: the org's team name, or the rung's own wording. */
	team: string;
	/** Requests served in the period. */
	requests: number;
	/** Consumption summed across every metered resource. */
	tokens: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** UTC month names for the period label (locale-independent, like the mockup). */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// =============================================================================
// PERIOD
// =============================================================================

/**
 * The calendar month (UTC) containing `now`: the period the pane reports.
 *
 * @param now - The instant whose month is wanted.
 * @returns The month's ISO bounds and its label.
 */
export function monthPeriod(now: Date): UsagePeriod {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	return {
		since: new Date(Date.UTC(year, month, 1)).toISOString(),
		until: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
		label: `${MONTHS[month]} ${year}`,
	};
}

// =============================================================================
// ROWS
// =============================================================================

/**
 * Who answered a publication row, in the pane's words.
 *
 * A development run has no publication; `@me` answers for the caller alone;
 * a team publication shows the org's team name, and an answering team the
 * org cannot name (another org's publication) shows the rung.
 *
 * @param row - One server row.
 * @returns The "Publishing team" cell text.
 */
export function publishingTeamLabel(row: PublicationUsage): string {
	// Step 1: the rungs that have no team to name
	if (row.rung === 'dev') return 'Development run';
	if (row.rung === 'me') return 'Only me';
	// Step 2: the org's own team, by name
	if (row.teamName) return row.teamName;
	// Step 3: a slot the org cannot name
	return row.rung === 'public' ? 'Public' : '--';
}

/**
 * Turns the server's publication rows into grid rows, largest consumer first.
 *
 * @param usage - Rows from `usage_by_publication`.
 * @returns One display row per publication.
 */
export function publicationRows(usage: PublicationUsage[]): PublicationRow[] {
	const rows = usage.map((row) => ({
		id: `${row.pipe}:${row.rung}:${row.team ?? '-'}:${row.version ?? '-'}`,
		publication: row.pipe || '--',
		version: row.version == null ? '--' : `v${row.version}`,
		team: publishingTeamLabel(row),
		requests: row.requestCount,
		tokens: Object.values(row.credits).reduce((sum, value) => sum + value, 0),
	}));
	rows.sort((a, b) => b.tokens - a.tokens);
	return rows;
}
