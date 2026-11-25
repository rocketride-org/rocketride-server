// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Plain words for what the Playground shows: friendly field names, relative
 * dates, conversation titles, and an agent name worked out from an address.
 * Pure functions, no imports, so node:test drives them directly.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** A conversation title's longest form (the Agent tool truncates at the same length). */
export const TITLE_MAX = 60;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// =============================================================================
// FIELD NAMES
// =============================================================================

/**
 * A returned key as words: underscores, dashes and camelCase become spaces,
 * and only the first letter is capitalised (`invoice_number` → "Invoice
 * number", `dueDate` → "Due date"). An all-capitals word (an acronym) keeps
 * its case. Values are never touched — only keys get friendly names.
 *
 * @param key - The key as returned.
 * @returns The friendly name (the key itself when it has no letters).
 */
export function friendlyName(key: string): string {
	// step: split on separators and on lower→upper case changes
	const spaced = key
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim();
	if (!spaced) return key;

	// step: lowercase every word but acronyms, then capitalise the first letter
	const words = spaced.split(' ').map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w.toLowerCase()));
	const joined = words.join(' ');
	return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * An agent's name worked out from its address, for an agent with no listing:
 * the pipeline id in title case (`acme.invoiceReader` → "Invoice Reader").
 *
 * @param address - The pipe or source address.
 * @returns The name.
 */
export function nameFromAddress(address: string): string {
	const segments = address.replace(/^[@=][^/]*\//, '').split('.');
	const id = segments[1] ?? segments[0] ?? address;
	return friendlyName(id)
		.split(' ')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

// =============================================================================
// DATES
// =============================================================================

/**
 * A stamp in the Agent tool's relative words: minutes or hours within the
 * day ("12m ago", "3h ago"), "yesterday", then a short month-day ("Nov 16").
 *
 * @param date - Epoch ms.
 * @param now - Epoch ms to measure from (defaults to the clock).
 * @returns The relative label.
 */
export function relativeDate(date: number, now: number = Date.now()): string {
	const elapsed = Math.max(0, now - date);
	if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))}m ago`;
	if (elapsed < DAY) return `${Math.round(elapsed / HOUR)}h ago`;
	if (elapsed < 2 * DAY) return 'yesterday';
	return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * A clock time for a bubble ("14:32").
 *
 * @param date - Epoch ms.
 * @returns The time.
 */
export function clockTime(date: number): string {
	return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Seconds since a start, for a progress line ("3 s", "1 m 4 s").
 *
 * @param startedAt - Epoch ms.
 * @param now - Epoch ms to measure to.
 * @returns The duration in words.
 */
export function elapsedWords(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) return `${seconds} s`;
	return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

// =============================================================================
// CONVERSATION TITLES
// =============================================================================

/**
 * Truncates a title to {@link TITLE_MAX} characters with an ellipsis.
 *
 * @param text - The full text.
 * @returns The title.
 */
function clip(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/**
 * A conversation's title from its first question.
 *
 * @param question - The question's text.
 * @returns The title.
 */
export function titleFromQuestion(question: string): string {
	return clip(question);
}

/**
 * A conversation's title from its first files: the first file's name and
 * how many more ("globex-0142.pdf and 45 more").
 *
 * @param names - The file names, in drop order.
 * @returns The title.
 */
export function titleFromFiles(names: string[]): string {
	if (names.length === 0) return 'Files';
	if (names.length === 1) return clip(names[0]);
	return clip(`${names[0]} and ${names.length - 1} more`);
}

/**
 * A file count in words ("1 file", "46 files").
 *
 * @param count - How many.
 * @returns The words.
 */
export function fileCount(count: number): string {
	return count === 1 ? '1 file' : `${count} files`;
}
