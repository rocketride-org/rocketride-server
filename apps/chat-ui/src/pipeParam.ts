// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The `pipe=` deep-link parameter (plan 3.6).
 *
 * In the browser the shell opens this app from
 * `?appid=rocketride.chat&pipe=<address>`; the address names the pipe (and
 * optionally its chat source) the app binds to. The app reads the parameter
 * itself — the shell passes no query to apps — and writes it back when the
 * person chose a pipe on the landing view, so the page is shareable and
 * survives a reload. The one-shot `auth=` hand-off is consumed by the shell
 * before any app mounts and never appears here.
 */

/** The query parameter carrying the pipe address. */
const PIPE_PARAM = 'pipe';

/**
 * The address the page was opened with, or null when none was given.
 *
 * @returns The `pipe` query value, trimmed, or null.
 */
export function pipeFromLocation(): string | null {
	if (typeof window === 'undefined') return null;
	const value = new URLSearchParams(window.location.search).get(PIPE_PARAM);
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Record the chosen address in the URL without a navigation.
 *
 * @param address - The pipe address the app is now bound to.
 */
export function writePipeToLocation(address: string): void {
	if (typeof window === 'undefined') return;
	const url = new URL(window.location.href);
	url.searchParams.set(PIPE_PARAM, address);
	window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * A light grammar check for an address typed by hand: two or three dot-free
 * segments of `[A-Za-z0-9_-]`. The server is the authority; this only stops
 * an obviously malformed string from being sent.
 *
 * @param value - The typed text.
 * @returns True when the text has the shape of an address.
 */
export function looksLikeAddress(value: string): boolean {
	return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/.test(value.trim());
}
