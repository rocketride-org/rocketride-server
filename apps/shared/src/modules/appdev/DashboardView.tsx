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
// DASHBOARD VIEW — everything that needs doing, at a glance
// =============================================================================

/**
 * The DASHBOARD view — the App Builder's landing tab. The lead card SPEAKS:
 * it narrates the app's state in plain English (latest version, its review
 * state, what serves where) and recommends the next step in full sentences —
 * no label-speak. Alongside it: the review conversation with the store
 * reviewer, where the app is live, and recent activity.
 *
 * The conversation IS the app's deployment history — the WHOLE of it, one
 * chronological stream: every system event (deploy, publish, submission,
 * verdict) renders as a timeline item on the dot rail, and 'reply' rows
 * render as chat bubbles woven in at their timestamps (developer
 * right/brand, admin left/surface — the developer's own side sits right,
 * mirroring the reviewer's App Admin surface). The reply box sits at the
 * bottom of the same stream, so the dashboard reads as one conversation
 * between the developer and the system.
 *
 * Liveness (v1): the host re-creates its adapter on account changes (verdict
 * pushes ride app:statusChanged into that re-mint), which re-runs the
 * [host]-keyed refresh; replies have no push event yet, so the card carries
 * a manual Refresh and reloads after the developer's own send.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from 'shell';
import { Button } from 'shell';
import { Card } from 'shell';
import { EmptyState } from 'shell';
import { InputField } from 'shell';
import { Modal } from 'shell';
import { StatusBadge } from 'shell';
import type { AppBuilderStage, AppHistoryEntry, AppSummary, AppVersionInfo, BuildStatusTick, IAppBuilderHost, PreflightCheck, RungPin, WatchStatus } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DashboardView} component. */
export interface IDashboardViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
	/** Namespace mismatch: disable the reply box (the view stays readable). */
	readOnly?: boolean;
	/** Deep-link into another tab from an attention row ("Open Deploy"). */
	onNavigate?: (stage: AppBuilderStage) => void;
}

/** One sentence of the narrated status — the card speaks plain English. */
interface StatusLine {
	/** Sentence tone: 'plain' narrates, 'warn'/'error' tint the text,
	 * 'note' is the quiet standing footnote. */
	tone: 'plain' | 'warn' | 'error' | 'note';
	/** The sentence itself — full natural language, no label-speak. */
	text: string;
	/** Tab that carries the recommended action, rendered as an "Open ..." button. */
	stage?: AppBuilderStage;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// The view owns the FULL tab height and never scrolls as a page — the
	// conversation card flexes to the available space and only its inner
	// stream scrolls (a fixed stream height made the card overflow the tab).
	wrap: {
		height: '100%',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	},
	head: {
		padding: '18px 26px 0',
		flexShrink: 0,
	},
	h1: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	sub: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
		lineHeight: 1.5,
	},
	grid: {
		// Conversation right and WIDE — it is the app's whole story; the
		// status/where-live facts sit left. The grid takes the remaining tab
		// height and columns STRETCH into it (the conversation's fill chain).
		display: 'grid',
		gridTemplateColumns: '2fr 3fr',
		gap: 16,
		alignItems: 'stretch',
		margin: '16px 26px 24px',
		maxWidth: 1060,
		flex: 1,
		minHeight: 0,
	},
	// Left column: natural-height cards; scrolls on its own if the viewport
	// is shorter than the facts.
	col: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
		minHeight: 0,
		overflowY: 'auto',
	},
	// Right column: a fill chain down to the conversation card.
	colFill: {
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
	},
	// ── Status & next steps (narrated prose) ────────────────────────────────
	statusRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 12,
		padding: '5px 0',
	},
	statusText: {
		flex: 1,
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.65,
	},
	// ── Conversation — ONE chronological stream: system events on the
	//    timeline rail (the Review-history grammar), replies as bubbles ────
	chatScroll: {
		flex: 1,
		minHeight: 120,
		overflowY: 'auto',
		padding: '4px 2px',
	},
	stream: {
		position: 'relative',
		paddingLeft: 22,
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
	},
	streamRail: {
		position: 'absolute',
		left: 7,
		top: 6,
		bottom: 6,
		width: 1,
		background: 'var(--rr-border)',
	},
	tlItem: {
		position: 'relative',
		padding: '2px 0 6px',
	},
	tlDot: {
		position: 'absolute',
		left: -20,
		top: 7,
		width: 9,
		height: 9,
		borderRadius: '50%',
	},
	tlWhen: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
	},
	tlWhat: {
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		marginTop: 1,
		fontWeight: 600,
	},
	tlBy: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 1,
		lineHeight: 1.5,
	},
	// The deploy's "what changed" note, quoted under its timeline item.
	tlNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 1,
		lineHeight: 1.5,
		fontStyle: 'italic',
	},
	// A deploy whose SERVER BUILD failed — the rail's verdict on the row.
	tlFail: {
		fontSize: 11.5,
		color: 'var(--rr-color-error)',
		marginTop: 1,
		lineHeight: 1.5,
	},
	tlAction: {
		marginTop: 5,
	},
	// The build-log viewer body (inside the stock Modal).
	logPre: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11.5,
		lineHeight: 1.5,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '10px 12px',
		maxHeight: '55vh',
		overflowY: 'auto',
		color: 'var(--rr-text-primary)',
		margin: 0,
	},
	replyRow: {
		display: 'flex',
		gap: 10,
		marginTop: 10,
		paddingTop: 12,
		borderTop: '1px solid var(--rr-border)',
	},
	replyInput: {
		flex: 1,
	},
	replyHint: {
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
		marginTop: 6,
		lineHeight: 1.5,
	},
	replyError: {
		marginTop: 10,
	},
	// ── Where it's live ─────────────────────────────────────────────────────
	pinRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '7px 0',
		fontSize: 12.5,
		borderTop: '1px solid var(--rr-bg-widget-header)',
	},
	pinRowFirst: {
		borderTop: 'none',
	},
	pinHandle: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	},
	pinVersion: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	pinAudience: {
		flex: 1,
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
		textAlign: 'right',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	loadBanner: {
		margin: '16px 26px 0',
		maxWidth: 1060,
		flexShrink: 0,
	},
};

/**
 * Chat bubble style. The developer's own messages sit right in the brand
 * color; the reviewer's sit left on the widget surface — the same grammar
 * as the reviewer's App Admin surface with the sides swapped.
 *
 * @param isDeveloper - Whether the message side is the developer (this app's own side).
 * @returns The bubble style object.
 */
const bubble = (isDeveloper: boolean): React.CSSProperties => ({
	maxWidth: '78%',
	padding: '9px 13px',
	borderRadius: 12,
	fontSize: 12.5,
	lineHeight: 1.55,
	alignSelf: isDeveloper ? 'flex-end' : 'flex-start',
	background: isDeveloper ? 'var(--rr-brand)' : 'var(--rr-bg-widget)',
	color: isDeveloper ? '#fff' : 'var(--rr-text-primary)',
	border: isDeveloper ? 'none' : '1px solid var(--rr-border)',
	borderBottomRightRadius: isDeveloper ? 4 : 12,
	borderBottomLeftRadius: isDeveloper ? 12 : 4,
	whiteSpace: 'pre-wrap',
	wordBreak: 'break-word',
});

/**
 * Meta line under a bubble (actor and timestamp), aligned to its side.
 *
 * @param isDeveloper - Whether the message side is the developer.
 * @returns The meta-line style object.
 */
const bubbleMeta = (isDeveloper: boolean): React.CSSProperties => ({
	fontSize: 10.5,
	color: 'var(--rr-text-secondary)',
	alignSelf: isDeveloper ? 'flex-end' : 'flex-start',
	marginTop: -4,
});

// Sentence text color per tone — plain sentences narrate in the normal
// foreground; warnings and errors tint the whole sentence.
const TONE_COLOR: Record<StatusLine['tone'], string> = {
	plain: 'var(--rr-text-primary)',
	warn: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
	note: 'var(--rr-text-secondary)',
};

// =============================================================================
// HISTORY VOCABULARY
// =============================================================================

// Timeline dot color per action — review verdicts carry their semantic
// color, plain machine ops stay neutral.
const STREAM_DOT: Record<string, string> = {
	request: 'var(--rr-color-warning)',
	approved: 'var(--rr-color-success)',
	rejected: 'var(--rr-color-error)',
	failed: 'var(--rr-color-error)',
	errored: 'var(--rr-color-error)',
	withdrawn: 'var(--rr-text-disabled)',
};

// Human labels for machine actions (the timeline item titles). 'publish'
// is deliberately absent — its two flavors are told apart by payload in
// {@link streamLabel}, per the settled vocabulary (deploy = version to the
// server, publish = bind to a rung).
const ACTION_LABEL: Record<string, string> = {
	request: 'submitted for review',
	approved: 'approved',
	rejected: 'rejected',
	withdrawn: 'withdrawn from review',
	failed: 'build failed',
	deploy: 'deployed',
	rollback: 'rolled back',
	enable: 'enabled',
	disable: 'disabled',
	enabled: 'enabled',
	disabled: 'disabled',
	remove: 'removed',
	removed: 'removed',
	errored: 'errored',
};

/**
 * The audience handle a publish row bound to. Rows written since the
 * self-describing-history contract carry the server-dereferenced handle
 * ('@team/Engineering'); legacy rows fall back to a generic spelling
 * composed from the type alone.
 *
 * @param audience - The row's audience payload.
 * @returns The display handle, '' when absent.
 */
function audienceHandle(audience: { type?: string; handle?: string } | undefined): string {
	if (audience?.handle) return audience.handle;
	if (!audience?.type) return '';
	if (audience.type === 'user') return '@me';
	if (audience.type === 'public') return '@public';
	return '@team';
}

/**
 * The timeline title verb for one history row. A 'publish' row carrying an
 * audience is the PUBLISH (bind to a rung) — with the version it repointed
 * OFF of when the row records one; without an audience it is the registry
 * write — the DEPLOY — per the settled deploy/publish vocabulary. The
 * binding-lifecycle rows (removed/disabled/enabled) name their rung the
 * same way — "v15 removed" alone reads like the VERSION vanished.
 *
 * @param entry - The history row.
 * @returns The verb phrase after "vN ".
 */
function streamLabel(entry: AppHistoryEntry): string {
	const handle = audienceHandle(entry.data?.audience);
	if (entry.action === 'publish') {
		if (!handle) return 'deployed to the server';
		const prev = entry.data?.previousVersion;
		return prev ? `published to ${handle} (was v${prev})` : `published to ${handle}`;
	}
	if (handle) {
		if (entry.action === 'removed' || entry.action === 'remove') return `removed from ${handle}`;
		if (entry.action === 'disabled' || entry.action === 'disable') return `disabled on ${handle}`;
		if (entry.action === 'enabled' || entry.action === 'enable') return `re-enabled on ${handle}`;
	}
	return ACTION_LABEL[entry.action] ?? entry.action;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Classify a version's server build word. The build status is a SEPARATE
 * axis from the review state — a 'private' draft whose build failed can
 * never serve, and recommending it for publish/review would be wrong.
 *
 * @param version - The rail entry (undefined-safe).
 * @returns 'ok' (servable — '' and 'ok' both count, legacy rows carry no
 *          word), 'failed', or 'running' (any in-flight ticker word).
 */
function buildStateOf(version: AppVersionInfo | undefined): 'ok' | 'failed' | 'running' {
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
function formatAt(epochSeconds: number): string {
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
function deriveStatus(
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
			submit: 'it is in review right now — the verdict will land here and in the conversation below',
			ready: 'it passed review and is approved',
			rejected: 'it was rejected in review',
			failed: 'its server build failed, so it never became servable',
		};
		// The build axis outranks the review state in the story: a draft
		// whose server build broke is NOT "ready for internal use", and a
		// still-running build is not anything yet.
		const build = buildStateOf(newest);
		const story =
			build === 'failed'
				? 'its server build FAILED, so this version cannot serve'
				: build === 'running'
					? `the server is still building it (${newest.buildStatus})`
					: (stateStory[newest.state ?? ''] ?? 'its state is unknown');
		lines.push({
			tone: 'plain',
			text: `Your latest version is v${newest.registryVersion}${semver}, deployed${when}${who} — ${story}.`,
		});
	}

	// ── What is serving where, in one sentence ───────────────────────────
	if (pins.length > 0) {
		const serving = pins.map((p) => `${p.handle} serves v${p.registryVersion}${p.version ? ` (${p.version})` : ''}`).join(', ');
		lines.push({ tone: 'plain', text: `Right now ${serving}.` });
	} else if (newest) {
		lines.push({ tone: 'plain', text: 'It is not being served to anyone yet.' });
	}

	// ── Problems first — anything broken outranks any suggestion ─────────
	if (watch?.state === 'error') {
		lines.push({
			tone: 'error',
			text: `Heads up: your local build is failing — ${watch.reason || 'see the Console for details'}. The preview and your next deploy both depend on it.`,
			stage: 'design',
		});
	}
	if (newest && buildStateOf(newest) === 'failed') {
		lines.push({
			tone: 'error',
			text: `v${newest.registryVersion} failed its server build — click the failed badge on its card in Deploy to read the build log, then fix the source and deploy a new version. A version whose build failed can never be published or reviewed.`,
			stage: 'deploy',
		});
	}
	if (newest?.state === 'failed') {
		lines.push({
			tone: 'error',
			text: 'Check the build output in the Console, fix the error, and deploy again — a failed version cannot be published or reviewed.',
			stage: 'design',
		});
	}
	if (newest?.state === 'rejected') {
		lines.push({
			tone: 'error',
			text: 'Read the notes from the reviewer in the conversation below, fix what they flagged, and deploy a new version — a rejection is final for that version.',
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
		lines.push({ tone: 'warn', text: 'The reviewer sent you a message — it is waiting in the conversation below.' });
	}

	// ── Next steps: what you might do from here. Only a version whose
	// build is green gets recommended anywhere — suggesting publish or
	// review for an unservable version would be advice the server refuses.
	const newestBuild = buildStateOf(newest);
	if (newest && newestBuild === 'running') {
		lines.push({
			tone: 'plain',
			text: 'Hang tight — once the build finishes, you can publish it or submit it for review.',
		});
	} else if (newest && newestBuild === 'failed') {
		// The error sentence above already says what to do; no cheerful
		// recommendation on top of it.
	} else if (newest?.state === 'ready' && publicPin?.registryVersion !== newest.registryVersion) {
		lines.push({
			tone: 'plain',
			text: `All is well — v${newest.registryVersion} is approved. If you want, publish it to @public and the store starts serving it.`,
			stage: 'deploy',
		});
	} else if (newest?.state === 'ready') {
		lines.push({ tone: 'plain', text: 'All is well — the store is serving your approved version. Nothing needs doing.' });
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
			text: 'Nothing needs doing while the review runs — you can keep working; deploying a new version simply withdraws this submission.',
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

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the DASHBOARD view: the narrated status, the review conversation,
 * where the app is live, and recent activity.
 *
 * @param props - See {@link IDashboardViewProps}.
 */
export const DashboardView: React.FC<IDashboardViewProps> = ({ host, app, readOnly, onNavigate }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	// null = first load in flight; [] = loaded and empty.
	const [history, setHistory] = useState<AppHistoryEntry[] | null>(null);
	const [versions, setVersions] = useState<AppVersionInfo[]>([]);
	const [pins, setPins] = useState<RungPin[]>([]);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	const [watch, setWatch] = useState<WatchStatus | null>(null);
	const [loadError, setLoadError] = useState('');

	// ── Reply state ──────────────────────────────────────────────────────
	const [reply, setReply] = useState('');
	const [sending, setSending] = useState(false);
	const [replyError, setReplyError] = useState('');

	// ── Build-log viewer (opened from a failed event's button) ───────────
	// logFor: the registry version whose log is open (null = closed);
	// logText: null = loading, text = loaded.
	const [logFor, setLogFor] = useState<number | null>(null);
	const [logText, setLogText] = useState<string | null>(null);

	/** Open the build-log viewer for one version and fetch its log. */
	const openBuildLog = useCallback(
		(version: number): void => {
			setLogFor(version);
			setLogText(null);
			if (!host.loadBuildLog) {
				setLogText('Build-log reading is not wired up on this host.');
				return;
			}
			void host
				.loadBuildLog(version)
				.then((text) => setLogText(text || 'No build log exists for this version.'))
				.catch((e) => setLogText(`Could not load the build log: ${e instanceof Error ? e.message : String(e)}`));
		},
		[host]
	);

	/** Batched refresh: history, rail, pins, and pre-flight in one round. */
	const refresh = useCallback(async (): Promise<void> => {
		setLoadError('');
		try {
			const [h, v, p, c] = await Promise.all([
				host.loadHistory?.() ?? Promise.resolve([]),
				host.listVersions?.() ?? Promise.resolve([]),
				host.getWhereLive?.() ?? Promise.resolve([]),
				host.runPreflight?.() ?? Promise.resolve([]),
			]);
			setHistory(h);
			setVersions(v);
			setPins(p);
			setChecks(c);
		} catch (e) {
			// Not connected / server unreachable: keep the cards rendered on
			// their empty states and say why the server-side facts are missing.
			setHistory((prev) => prev ?? []);
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, [host]);

	// [host]-keyed: the VSCode adapter re-mints on account changes (verdict
	// pushes included), so this ALSO serves as the live-refresh trigger.
	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Latest local watch/build status for the attention rules.
	useEffect(() => host.subscribeWatch?.((s) => setWatch(s)), [host.subscribeWatch]);

	// Live SERVER-build ticker: a deploy's failure or success lands as build
	// ticks, NOT as an account change — without this the card would narrate
	// a stale rail until the next full refresh. A terminal tick ('' =
	// success, 'failed') also re-pulls the rail so the persisted buildStatus
	// takes over from the overlay.
	const [buildTicks, setBuildTicks] = useState<Record<number, string>>({});
	useEffect(() => host.subscribeBuildStatus?.((tick: BuildStatusTick) => {
		if (tick.version == null) return;
		setBuildTicks((prev) => ({ ...prev, [tick.version as number]: tick.status }));
		if (tick.status === '' || tick.status === 'failed') void refresh();
	}), [host.subscribeBuildStatus, refresh]);

	// The rail with the live ticker overlaid — the freshest build word wins
	// ('' is the success terminal and reads as servable).
	const liveVersions = useMemo(
		() => versions.map((v) => {
			const word = buildTicks[v.registryVersion];
			return word === undefined ? v : { ...v, buildStatus: word === '' ? 'ok' : word };
		}),
		[versions, buildTicks],
	);

	const status = useMemo(
		() => deriveStatus(liveVersions, pins, checks, watch, history ?? []),
		[liveVersions, pins, checks, watch, history],
	);

	// The rail's build verdict per version, for the timeline join below: a
	// server-build failure never writes a history row (the worker stamps the
	// ARTIFACT), so without this join a failed deploy reads healthy in the
	// conversation and its log is unreachable from the story.
	const buildByVersion = useMemo(
		() => new Map(liveVersions.map((v) => [v.registryVersion, buildStateOf(v)])),
		[liveVersions],
	);

	// Keep the stream pinned to its newest entry on every (re)load.
	const chatRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = chatRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [history]);

	/** Send the reply, then reload so the row renders from the server's
	 * serialization (no optimistic insert). */
	const sendReply = useCallback(async (): Promise<void> => {
		const message = reply.trim();
		if (!host.sendReply || message.length === 0 || readOnly) return;
		setSending(true);
		setReplyError('');
		try {
			await host.sendReply(message);
			setReply('');
			await refresh();
		} catch (e) {
			setReplyError(e instanceof Error ? e.message : String(e));
		} finally {
			setSending(false);
		}
	}, [host, reply, readOnly, refresh]);

	// =====================================================================
	// RENDER
	// =====================================================================

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>Dashboard — where things stand with this app, the conversation with the reviewer, and what you might do next.</div>
			</div>

			{/* Server-side facts unavailable — the cards below stay on their empty states */}
			{loadError ? (
				<div style={styles.loadBanner}>
					<Banner variant="info">Not connected to a RocketRide server — {loadError}. Server-side status appears here once connected.</Banner>
				</div>
			) : null}

			<div style={styles.grid}>
				{/* ── Left: the facts — status + where it's live ──────────── */}
				<div style={styles.col}>
					<Card header="Status & next steps">
						{history === null ? (
							<div style={styles.statusRow}>
								<div style={styles.statusText}>Looking at the current state...</div>
							</div>
						) : (
							status.map((line) => (
								<div key={line.text} style={styles.statusRow}>
									<div style={{ ...styles.statusText, color: TONE_COLOR[line.tone] }}>{line.text}</div>
									{line.stage && onNavigate ? (
										<Button variant="secondary" small onClick={() => onNavigate(line.stage as AppBuilderStage)}>
											Open {line.stage.charAt(0).toUpperCase() + line.stage.slice(1)}
										</Button>
									) : null}
								</div>
							))
						)}
					</Card>

					<Card header="Where it's live">
						{pins.length === 0 ? (
							<EmptyState title="Not serving anywhere" description="Publish a version to @me, @team, or @public and its pin appears here." />
						) : (
							pins.map((pin, i) => (
								<div key={pin.handle} style={i === 0 ? { ...styles.pinRow, ...styles.pinRowFirst } : styles.pinRow}>
									<span style={styles.pinHandle}>{pin.handle}</span>
									<span style={styles.pinVersion}>v{pin.registryVersion}{pin.version ? ` · ${pin.version}` : ''}</span>
									<StatusBadge variant={pin.state === 'pending' ? 'muted' : 'info'}>
										{pin.state === 'enabled' ? 'live' : pin.state === 'approved' ? 'live' : 'in review'}
									</StatusBadge>
									<span style={styles.pinAudience}>{pin.audience}</span>
								</div>
							))
						)}
					</Card>
				</div>

				{/* ── Right: the whole story — every system event on the
				    timeline rail, replies as bubbles, chat at the bottom ── */}
				<div style={styles.colFill}>
					<Card
						header="Conversation"
						fill
						headerActions={
							<Button variant="secondary" small onClick={() => void refresh()}>Refresh</Button>
						}
					>
						<div ref={chatRef} style={styles.chatScroll}>
							{history === null ? (
								<div style={styles.tlBy}>Loading the app&rsquo;s history...</div>
							) : history.length === 0 ? (
								<EmptyState title="Nothing yet" description="Deploys, publishes, review verdicts, and reviewer messages appear here once the app is on the server." />
							) : (
								<div style={styles.stream}>
									<div style={styles.streamRail} />
									{history.map((entry) => {
										if (entry.action === 'reply' && entry.data?.message) {
											const isDeveloper = entry.data.side === 'developer';
											return (
												<React.Fragment key={entry.seq}>
													<div style={bubble(isDeveloper)}>{entry.data.message}</div>
													<div style={bubbleMeta(isDeveloper)}>
														{(entry.actor?.display || entry.actor?.email || entry.data.side || '')} · {formatAt(entry.at)}
													</div>
												</React.Fragment>
											);
										}
										// System event — one timeline item in the Review-history
										// grammar: colored dot, mono timestamp, bold what, by-line.
										// A failed event carries its WHY one click away.
										const actor = entry.actor?.display || entry.actor?.email || '';
										// A DEPLOY row (publish without an audience) quotes the
										// developer's "what changed" note under the title — and
										// joins the RAIL's build verdict, because the worker's
										// failure stamps the artifact, never the history stream.
										const isDeploy = entry.action === 'publish' && !entry.data?.audience;
										const note = isDeploy ? entry.data?.comment : undefined;
										const buildFailed = isDeploy && entry.version != null && buildByVersion.get(entry.version) === 'failed';
										const showLog = (entry.action === 'failed' || buildFailed) && entry.version != null && Boolean(host.loadBuildLog);
										return (
											<div key={entry.seq} style={styles.tlItem}>
												<div style={{ ...styles.tlDot, background: buildFailed ? 'var(--rr-color-error)' : STREAM_DOT[entry.action] ?? 'var(--rr-border)' }} />
												<div style={styles.tlWhen}>{formatAt(entry.at)}</div>
												<div style={styles.tlWhat}>{`${entry.version != null ? `v${entry.version} ` : ''}${streamLabel(entry)}`}</div>
												{note ? <div style={styles.tlNote}>&ldquo;{note}&rdquo;</div> : null}
												{buildFailed ? <div style={styles.tlFail}>the server build failed — this version can never serve</div> : null}
												{actor ? <div style={styles.tlBy}>by {actor}</div> : null}
												{showLog ? (
													<div style={styles.tlAction}>
														<Button variant="secondary" small onClick={() => openBuildLog(entry.version as number)}>View build log</Button>
													</div>
												) : null}
											</div>
										);
									})}
								</div>
							)}
						</div>

						{host.sendReply ? (
							<>
								<div style={styles.replyRow}>
									<div style={styles.replyInput}>
										<InputField
											placeholder={readOnly ? 'Replies disabled' : versions.length === 0 ? 'Ask the review team a question...' : 'Reply to the reviewer...'}
											value={reply}
											disabled={readOnly}
											maxLength={4000}
											onChange={(e) => setReply(e.target.value)}
											onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); } }}
										/>
									</div>
									<Button disabled={sending || reply.trim().length === 0 || !!readOnly} onClick={() => void sendReply()}>
										{sending ? 'Sending...' : 'Send'}
									</Button>
								</div>
								{readOnly ? (
									<div style={styles.replyHint}>Replies are disabled: this app&rsquo;s id is outside your organization&rsquo;s developer namespace.</div>
								) : null}
								{replyError ? (
									<div style={styles.replyError}>
										<Banner variant="error">{replyError}</Banner>
									</div>
								) : null}
							</>
						) : (
							<div style={styles.replyHint}>Replying is not wired up on this host yet — the thread is read-only here.</div>
						)}
					</Card>
				</div>
			</div>

			{/* ── Build-log viewer — the failed event's click-through ────── */}
			{logFor !== null && (
				<Modal
					title={`v${logFor} build log`}
					// 80% of the pane: build-log lines are long — the stock box
					// wraps them into porridge.
					width={Math.floor(window.innerWidth * 0.8)}
					onClose={() => setLogFor(null)}
					footer={
						<Button variant="secondary" onClick={() => setLogFor(null)}>
							Close
						</Button>
					}
				>
					<pre style={styles.logPre}>{logText === null ? 'Loading build log...' : logText}</pre>
				</Modal>
			)}
		</div>
	);
};
