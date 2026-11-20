// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The pure halves of the Billing pane's load (AccountProvider.loadBilling).
 *
 * Billing events start loads without an org change, so two loads may be in
 * flight at once: a generation guard lets only the newest commit. And the
 * served-by-publication read settles into usage OR an error, so a failed
 * read is never mistaken for a month with no usage. No React, no DOM, so a
 * node test covers both.
 */

import type { PublicationUsage } from '../types';

// =============================================================================
// TYPES
// =============================================================================

/** Hands out load generations and says whether one is still the newest. */
export interface LoadGenerations {
	/** Starts a load: its generation, which retires every earlier one. */
	begin(): number;
	/** True while no later load has begun. */
	isCurrent(generation: number): boolean;
}

/** The served-by-publication read, settled: rows on success, a message on failure. */
export interface PublicationLoad {
	/** The rows; [] for a month with no usage AND for a failed read. */
	usage: PublicationUsage[];
	/** Why the read failed, or null when it answered (even with no rows). */
	error: string | null;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Shown when a failed read carries no message of its own. */
export const PUBLICATION_LOAD_FAILED = 'Publication usage could not be loaded.';

// =============================================================================
// LOAD GENERATIONS
// =============================================================================

/**
 * A fresh generation counter for one loader.
 *
 * @returns The counter; the first `begin()` returns 1.
 */
export function createLoadGenerations(): LoadGenerations {
	let latest = 0;
	return {
		begin: () => ++latest,
		isCurrent: (generation) => generation === latest,
	};
}

// =============================================================================
// PUBLICATION READ
// =============================================================================

/**
 * Settles the served-by-publication read without throwing.
 *
 * @param request - The pending `getUsageByPublication` call.
 * @returns The rows and a null error, or no rows and the failure's message.
 */
export async function settlePublicationUsage(request: Promise<PublicationUsage[]>): Promise<PublicationLoad> {
	try {
		return { usage: await request, error: null };
	} catch (err) {
		const message = err instanceof Error && err.message ? err.message : PUBLICATION_LOAD_FAILED;
		return { usage: [], error: message };
	}
}
