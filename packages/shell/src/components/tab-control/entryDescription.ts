// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * entryDescription: the tooltip text of a view-menu entry.
 *
 * One rule for every place a {@link ViewMenuEntry} description becomes a
 * native `title`: TabControl's strip tabs and overflow menu rows, and
 * DetailPanel's tabs. Internal building block, like ViewMenuBadge: not part
 * of the shared public surface.
 */

import type { ViewMenuEntry } from '../../types/viewMenu';

/**
 * Returns the entry's description, trimmed, or undefined when it is absent,
 * empty or whitespace-only (so the caller renders no `title` attribute).
 *
 * @param entry - The view-menu entry.
 * @returns The trimmed description, or undefined.
 */
export function entryDescription(entry: Pick<ViewMenuEntry, 'description'>): string | undefined {
	return entry.description?.trim() || undefined;
}
