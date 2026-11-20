// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * latestGate — only the newest of overlapping reads may write its result.
 *
 * Several triggers can start the same read at once (a mount, a server push,
 * the refresh after a verb), and their answers land in any order. Each read
 * takes a ticket when it starts and asks the gate before writing: an older
 * read that lands last is dropped instead of painting stale data over a
 * newer answer. Nothing is cancelled; the losing result is simply ignored.
 */

// =============================================================================
// TYPES
// =============================================================================

/** The ticket counter one place shares across its overlapping reads. */
export interface ILatestGate {
	/** Takes the next ticket; call when a read starts. */
	take(): number;
	/** Whether a ticket is still the newest; call before writing a result. */
	isLatest(ticket: number): boolean;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Creates a gate. Keep one per place that writes (a component instance), so
 * reads of different places never supersede each other.
 *
 * @returns A fresh gate whose first ticket is 1.
 */
export function createLatestGate(): ILatestGate {
	let newest = 0;
	return {
		take: () => ++newest,
		isLatest: (ticket) => ticket === newest,
	};
}
