// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pure helpers behind the Profile's TEAMS card (B39): the member's team
 * order in the active organization. The server stores the order and lists
 * `organization.teams` by it; these helpers only shape what the card shows
 * and what a drop sends back.
 */

import type { TeamInfo } from 'rocketride';

/**
 * English ordinal for a 1-based position ("1st", "2nd", "3rd", "4th", ...).
 *
 * @param n - The position, starting at 1.
 * @returns The ordinal label.
 */
export function ordinal(n: number): string {
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

/**
 * Orders the active org's teams by the member's team order: the teams named
 * in `order` first, in that order, then any team the order does not name,
 * in the server's listing order (the server appends joined teams at read,
 * so this is only a guard against a stale push). Ids the org has no team
 * for are ignored.
 *
 * @param teams - The active org's teams.
 * @param order - The member's team order (team ids), possibly empty.
 * @returns The teams in display order.
 */
export function orderTeams(teams: TeamInfo[], order: readonly string[]): TeamInfo[] {
	const byId = new Map(teams.map((t) => [t.id, t]));
	const named: TeamInfo[] = [];
	for (const id of order) {
		const t = byId.get(id);
		if (t && !named.includes(t)) named.push(t);
	}
	return [...named, ...teams.filter((t) => !named.includes(t))];
}

/**
 * Moves one element of a list to another index, returning a new list.
 *
 * @param list - The source list.
 * @param from - Index of the element to move.
 * @param to   - Index the element lands on.
 * @returns The reordered list (a copy of the input when nothing moves).
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	const next = [...list];
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return next;
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved as T);
	return next;
}
