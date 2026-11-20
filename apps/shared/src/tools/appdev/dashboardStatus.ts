// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The Dashboard's narrated status. Kept apart from the view, which imports
 * the shell, so node:test can load it.
 */

import type { AppBuilderStage, AppHistoryEntry, AppVersionInfo, PreflightCheck, RungPin, WatchStatus } from './types';
import { servingSentenceOf, youSentenceOf } from './servingStatus';

/** One sentence of the narrated status — the card speaks plain English. */
export interface StatusLine {
	/** Sentence tone: 'plain' narrates, 'warn'/'error' tint the text,
	 * 'note' is the quiet standing footnote. */
	tone: 'plain' | 'warn' | 'error' | 'note';
	/** The sentence itself — full natural language, no label-speak. */
	text: string;
	/** Tab that carries the recommended action, rendered as an "Open ..." button. */
	stage?: AppBuilderStage;
	/** Registry version whose build log the line opens; outranks `stage` when the host can read logs. */
	buildLog?: number;
}

/** The button a status line carries. */
export type StatusAction = { kind: 'buildLog'; version: number } | { kind: 'stage'; stage: AppBuilderStage };

/**
 * Pick the button for one status line: its build log when the host can read
 * logs, else the tab it names when the view can navigate, else none.
 *
 * @param line - The status line.
 * @param canReadLogs - Whether the host implements `loadBuildLog`.
 * @param canNavigate - Whether the view was given `onNavigate`.
 * @returns The action to render, or null for no button.
 */
export function statusActionOf(line: StatusLine, canReadLogs: boolean, canNavigate: boolean): StatusAction | null {
	if (line.buildLog !== undefined && canReadLogs) return { kind: 'buildLog', version: line.buildLog };
	if (line.stage && canNavigate) return { kind: 'stage', stage: line.stage };
	return null;
}

/**
 * Classify a version's server build word. The build status is a SEPARATE
 * axis from the review state — a 'private' draft whose build failed can
 * never serve, and recommending it for publish/review would be wrong.
 *
 * @param version - The rail entry (undefined-safe).
 * @returns 'ok' (servable — '' and 'ok' both count, legacy rows carry no
 *          word), 'failed', or 'running' (any in-flight ticker word).
 */
export function buildStateOf(version: AppVersionInfo | undefined): 'ok' | 'failed' | 'running' {
	const word = version?.buildStatus ?? '';
	if (word === '' || word === 'ok') return 'ok';
	if (word === 'failed') return 'failed';
	return 'running';
}

/**
 * Format an epoch-seconds timestamp as a short locale date + time line.
 *
 * @param epochSeconds - Seconds since the epoch.
 * @returns Locale-formatted date/time, or '' when unparseable.
 */
export function formatAt(epochSeconds: number): string {
	try {
		return new Date(epochSeconds * 1000).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
		});
	} catch {
		return '';
	}
}

/**
 * Narrate the app's state as plain English: where things stand (latest
 * version, its review state, what is serving where) followed by what the
 * developer might do next — recommendations, not label-speak. Pure — every
 * sentence derives only from its inputs, so the story re-derives on any
 * refresh.
 *
 * @param versions - The version rail, newest first.
 * @param pins - The where-live reverse index.
 * @param checks - Pre-flight results ([] until run).
 * @param watch - Latest local watch/build status (null before the first tick).
 * @param history - The history stream, oldest first.
 * @returns The status sentences, story first, problems and next steps after.
 */
export function deriveStatus(
	versions: AppVersionInfo[],
	pins: RungPin[],
	checks: PreflightCheck[],
	watch: WatchStatus | null,
	history: AppHistoryEntry[],
): StatusLine[] {
	const lines: StatusLine[] = [];
	const newest = versions[0];
	const publicPin = pins.find((p) => p.rung === 'public');

	// ── The story: what the latest version is and how it got here ────────
	if (!newest) {
		lines.push({
			tone: 'plain',
			text: 'This app has not been deployed yet, so nothing is on the server. When you are ready, deploy your first version and it will show up here.',
			stage: 'deploy',
		});
	} else {
		const when = newest.publishedAt ? ` on ${formatAt(newest.publishedAt)}` : '';
		const who = newest.author ? ` by ${newest.author}` : '';
		const semver = newest.version ? ` (${newest.version})` : '';
		const stateStory: Record<string, string> = {
			private: 'it is a private draft, ready for internal use',
			submit: 'it is in review right now, and the verdict will land here and in the conversation below',
			ready: 'it passed review and is approved',
			rejected: 'it was rejected in review',
			failed: 'the server could not store it completely, so it never built',
		};
		// The build axis outranks the review state in the story: a draft
		// whose server build broke is NOT "ready for internal use", and a
		// still-running build is not anything yet. A failed upload is the
		// exception: its build stays 'queued' but never runs.
		const build = buildStateOf(newest);
		const story =
			build === 'failed'
				? 'its server build FAILED, so this version cannot serve'
				: build === 'running' && newest.state !== 'failed'
					? `the server is still building it (${newest.buildStatus})`
					: (stateStory[newest.state ?? ''] ?? 'its state is unknown');
		lines.push({
			tone: 'plain',
			text: `Your latest version is v${newest.registryVersion}${semver}, deployed${when}${who}; ${story}.`,
		});
	}

	// ── What is serving where, in one sentence ───────────────────────────
	// Only what a browser is actually served counts as serving (#2461):
	// an audience set to a version that is not served says so, and why.
	if (pins.length > 0) {
		lines.push({ tone: 'plain', text: servingSentenceOf(pins) });
		const you = youSentenceOf(pins);
		if (you) lines.push({ tone: 'plain', text: you });
	} else if (newest) {
		lines.push({ tone: 'plain', text: 'It is not being served to anyone yet.' });
	}

	// ── Problems first — anything broken outranks any suggestion ─────────
	if (watch?.state === 'error') {
		lines.push({
			tone: 'error',
			text: `Heads up: your local build is failing (${watch.reason || 'see the Console for details'}). The preview and your next deploy both depend on it.`,
			stage: 'design',
		});
	}
	if (newest && buildStateOf(newest) === 'failed') {
		lines.push({
			tone: 'error',
			text: `v${newest.registryVersion} failed its server build. Read its build log to see why, then fix the source and deploy a new version. A version whose build failed can never be published or reviewed.`,
			stage: 'deploy',
			buildLog: newest.registryVersion,
		});
	}
	if (newest?.state === 'failed') {
		lines.push({
			tone: 'error',
			text: `v${newest.registryVersion} was not stored completely on the server, so it never built. Deploy a new version. A failed version cannot be published or reviewed.`,
			stage: 'deploy',
		});
	}
	if (newest?.state === 'rejected') {
		lines.push({
			tone: 'error',
			text: 'Read the notes from the reviewer in the conversation below, fix what they flagged, and deploy a new version. A rejection is final for that version.',
		});
	}
	// The two readiness bars separately — a broken PACKAGE blocks everything
	// (even a personal publish would ship a lying manifest), while missing
	// STORE requirements only matter when a submission is the goal.
	const packageFailing = checks.filter((c) => (c.tier ?? 'package') === 'package' && c.state === 'fail').length;
	if (packageFailing > 0) {
		lines.push({
			tone: 'warn',
			text: `${packageFailing === 1 ? 'One package item needs' : `${packageFailing} package items need`} fixing before this app is complete.`,
			stage: 'package',
		});
	}
	const storeFailing = checks.filter((c) => c.tier === 'store' && c.state === 'fail').length;
	if (storeFailing > 0) {
		lines.push({
			tone: 'warn',
			text: `Before your next store submission, ${storeFailing === 1 ? 'one store requirement needs' : `${storeFailing} store requirements need`} fixing.`,
			stage: 'store',
		});
	}
	const lastReply = [...history].reverse().find((e) => e.action === 'reply');
	if (lastReply?.data?.side === 'admin') {
		lines.push({ tone: 'warn', text: 'The reviewer sent you a message. It is waiting in the conversation below.' });
	}

	// ── Next steps: what you might do from here. Only a version whose
	// build is green gets recommended anywhere — suggesting publish or
	// review for an unservable version would be advice the server refuses.
	const newestBuild = buildStateOf(newest);
	if (newest && newestBuild === 'running' && newest.state !== 'failed') {
		lines.push({
			tone: 'plain',
			text: 'Hang tight. Once the build finishes, you can publish it or submit it for review.',
		});
	} else if (newest && newestBuild === 'failed') {
		// The error sentence above already says what to do; no cheerful
		// recommendation on top of it.
	} else if (newest?.state === 'ready' && publicPin?.registryVersion !== newest.registryVersion) {
		lines.push({
			tone: 'plain',
			text: `All is well: v${newest.registryVersion} is approved. If you want, publish it to @public and the store starts serving it.`,
			stage: 'deploy',
		});
	} else if (newest?.state === 'ready') {
		lines.push({ tone: 'plain', text: 'All is well: the store is serving your approved version. Nothing needs doing.' });
	} else if (newest?.state === 'private') {
		const behindPublic = publicPin && publicPin.registryVersion < newest.registryVersion;
		lines.push({
			tone: 'plain',
			text: behindPublic
				? `The store is still on v${publicPin.registryVersion}. If you want, you can try v${newest.registryVersion} on your desktop or share it with a team right away, or submit it for review to bring the store up to date.`
				: 'If you want, you can publish it to your desktop or one of your teams right away, or submit it for review to make it public.',
			stage: 'deploy',
		});
	} else if (newest?.state === 'submit') {
		lines.push({
			tone: 'plain',
			text: 'Nothing needs doing while the review runs. You can keep working; deploying a new version simply withdraws this submission.',
		});
	}

	// Standing footnote — the immutable-snapshot rule in one sentence, so
	// "why isn't my edit live" never needs asking: EVERYTHING (code,
	// pricing, icon, readme, settings) froze into the version at deploy.
	if (newest) {
		lines.push({
			tone: 'note',
			text: `Any changes to your application after the v${newest.registryVersion} deploy${newest.publishedAt ? ` on ${formatAt(newest.publishedAt)}` : ''} will not take effect until you deploy a new version.`,
		});
	}

	return lines;
}
