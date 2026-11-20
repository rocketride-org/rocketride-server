// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Serving-state wording for App Builder (#2461) — one place that turns the
 * server's per-pin serving truth into the words and tones the DEPLOY and
 * DASHBOARD views render, so both say the same thing.
 *
 * The server decides serving with the SAME gate that builds what a browser
 * is actually handed (binding enabled, deployment serveable for the rung,
 * build finished); these helpers only phrase it. Every helper falls back to
 * the pre-#2461 wording when an older server sends no serving fields.
 */

import type { AppVersionInfo, RungPin } from './types';

/** How a status reads at a glance. */
export type ServingTone = 'ok' | 'warn' | 'error' | 'muted';

/** The StatusBadge variants these helpers pick from. */
export type BadgeVariant = 'muted' | 'info' | 'success' | 'warning' | 'error';

/** Per-version review-state badge (the deployment's review lifecycle). */
export const STATE_BADGE: Record<NonNullable<AppVersionInfo['state']>, { variant: BadgeVariant; label: string }> = {
	private: { variant: 'muted', label: 'draft' },
	submit: { variant: 'warning', label: 'in review' },
	ready: { variant: 'success', label: 'ready' },
	rejected: { variant: 'error', label: 'rejected' },
	failed: { variant: 'error', label: 'failed' },
};

/** Why an audience is not served, in words: server reason -> phrase + tone. */
const REASONS: Record<string, { phrase: string; tone: ServingTone; standalone: boolean }> = {
	disabled: { phrase: 'disabled', tone: 'muted', standalone: true },
	building: { phrase: 'still building', tone: 'warn', standalone: false },
	'in-review': { phrase: 'in review', tone: 'warn', standalone: true },
	'not-approved': { phrase: 'not approved', tone: 'warn', standalone: true },
	rejected: { phrase: 'rejected', tone: 'error', standalone: true },
	failed: { phrase: 'build failed', tone: 'error', standalone: false },
	'build-failed': { phrase: 'build failed', tone: 'error', standalone: false },
};

/** Badge variant for a tone (ok never reaches here — serving is 'live'). */
const TONE_VARIANT: Record<ServingTone, BadgeVariant> = { ok: 'info', warn: 'warning', error: 'error', muted: 'muted' };

/** True unless the server says the pin does not serve (older servers: always). */
function isServing(pin: RungPin): boolean {
	return pin.serving !== false;
}

/** The short reason phrase for a non-serving pin ("still building"). */
function reasonPhraseOf(pin: RungPin): string {
	const reason = pin.reason ?? '';
	return REASONS[reason]?.phrase ?? (reason || 'unknown');
}

/** "v3 (1.2.0)" — the registry version plus the semver when known. */
function versionLabelOf(pin: RungPin): string {
	return `v${pin.registryVersion}${pin.version ? ` (${pin.version})` : ''}`;
}

/**
 * The where-live row's state word and tone.
 *
 * @param pin - One where-live pin.
 * @returns 'serving' (ok), or why the audience is not served; an older
 *          server's pin keeps the review-gate wording.
 */
export function pinStatusOf(pin: RungPin): { word: string; tone: ServingTone } {
	if (pin.serving === undefined) {
		return pin.state === 'pending' ? { word: 'in review', tone: 'warn' } : { word: pin.state, tone: 'ok' };
	}
	if (pin.serving) return { word: 'serving', tone: 'ok' };
	const known = REASONS[pin.reason ?? ''];
	const phrase = reasonPhraseOf(pin);
	return { word: known?.standalone ? phrase : `not serving: ${phrase}`, tone: known?.tone ?? 'warn' };
}

/**
 * The dashboard's "Where it's live" badge.
 *
 * @param pin - One where-live pin.
 * @returns 'live' for a serving pin, the status word otherwise.
 */
export function liveBadgeOf(pin: RungPin): { variant: BadgeVariant; label: string } {
	if (pin.serving === undefined) {
		return pin.state === 'pending' ? { variant: 'muted', label: 'in review' } : { variant: 'info', label: 'live' };
	}
	if (pin.serving) return { variant: 'info', label: 'live' };
	const status = pinStatusOf(pin);
	return { variant: TONE_VARIANT[status.tone], label: status.word };
}

/**
 * One sentence: who is served which version right now, and which audiences
 * are set to a version that is not serving (and why).
 *
 * @param pins - The where-live reverse index.
 * @returns The sentence, or '' when there are no pins.
 */
export function servingSentenceOf(pins: RungPin[]): string {
	if (pins.length === 0) return '';
	const served = pins.filter(isServing).map((p) => `${p.handle} serves ${versionLabelOf(p)}`);
	const unserved = pins.filter((p) => !isServing(p)).map((p) => `${p.handle} is set to ${versionLabelOf(p)}, but it isn't serving (${reasonPhraseOf(p)})`);
	if (served.length === 0) return `It is not being served to anyone right now: ${unserved.join('; ')}.`;
	return `Right now ${served.join(', ')}${unserved.length ? `; ${unserved.join('; ')}` : ''}.`;
}

/**
 * One sentence: the version the caller would get right now (their own
 * published resolution — the most specific serving audience).
 *
 * @param pins - The where-live reverse index.
 * @returns The sentence, or '' when there are no pins or the server is too
 *          old to say.
 */
export function youSentenceOf(pins: RungPin[]): string {
	if (!pins.some((p) => p.servesYou !== undefined)) return '';
	const yours = pins.find((p) => p.servesYou);
	return yours ? `You'd get ${versionLabelOf(yours)} through ${yours.handle}.` : "You wouldn't get any published version.";
}

/**
 * The version card's badge. The build axis outranks the review state while
 * the version cannot serve: a failed build opens the build log, a running
 * build shows its ticker word — so a version still building never reads as
 * a green "ready".
 *
 * @param state - The deployment's review state.
 * @param buildWord - The effective server-build word ('' = servable).
 * @returns The badge, or null when there is nothing to show.
 */
export function versionBadgeOf(state: AppVersionInfo['state'] | undefined, buildWord: string): { variant: BadgeVariant; label: string; opensBuildLog: boolean } | null {
	if (buildWord === 'failed') return { variant: 'error', label: 'failed', opensBuildLog: true };
	if (buildWord) return { variant: 'warning', label: buildWord, opensBuildLog: false };
	if (!state) return null;
	const badge = STATE_BADGE[state];
	// STATE_BADGE is total over the typed union, but a state the server adds
	// later would be absent at runtime — show its raw name, muted.
	return badge ? { ...badge, opensBuildLog: false } : { variant: 'muted', label: state, opensBuildLog: false };
}
