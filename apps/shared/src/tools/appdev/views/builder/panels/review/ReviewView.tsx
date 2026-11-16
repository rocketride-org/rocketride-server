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
// REVIEW VIEW — the conversation with the store review team, by version
// =============================================================================

/**
 * PACKAGE › Review (named-pipes mockup 1.8b): the app's deployment history
 * and the review thread as ONE chronological stream, filtered by version.
 * Machine rows (deploy, publish, verdict) render as timeline items on the
 * dot rail; human 'reply' rows render as chat bubbles (the developer's own
 * on the right, in the brand color; the reviewer's on the left, mirroring
 * the reviewer's App Admin surface). The reply box sits at the bottom of
 * the same stream. Messaging the team never gates anything.
 *
 * This is what survived the DASHBOARD tab (retired 2026-11-16): its "status
 * and next steps" narration is gone — DESIGN is the landing view and
 * PACKAGE › Requirements is the checklist — and the thread moved here,
 * because it is about the version submitted from this page.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Card, EmptyState, InputField, Modal, ToggleGroup } from 'shell';
import type { AppHistoryEntry, AppSummary, AppVersionInfo, BuildStatusTick, IAppBuilderHost } from '../../../../types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ReviewView} component. */
export interface IReviewViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
	/** Namespace mismatch: disable the reply box (the view stays readable). */
	readOnly?: boolean;
}

/** The version filter: one registry version, or the whole thread. */
type VersionFilter = 'all' | number;

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// The pane owns its full height: the conversation card flexes and only
	// its inner stream scrolls.
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	filterRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		marginBottom: 10,
		flexShrink: 0,
	},
	filterLabel: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	},
	colFill: {
		display: 'flex',
		flexDirection: 'column',
		minHeight: 0,
		flex: 1,
	},
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
	tlNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 1,
		lineHeight: 1.5,
		fontStyle: 'italic',
	},
	tlFail: {
		fontSize: 11.5,
		color: 'var(--rr-color-error)',
		marginTop: 1,
		lineHeight: 1.5,
	},
	tlAction: {
		marginTop: 5,
	},
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
	loadBanner: {
		marginBottom: 12,
		flexShrink: 0,
	},
};

/**
 * Chat bubble style. The developer's own messages sit right in the brand
 * color; the reviewer's sit left on the widget surface.
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
 * write — the DEPLOY. The binding-lifecycle rows name their rung the same
 * way — "v15 removed" alone reads like the VERSION vanished.
 *
 * @param entry - The history row.
 * @returns The verb phrase after "vN ".
 */
export function streamLabel(entry: AppHistoryEntry): string {
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

/**
 * The rail's build verdict for one version.
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

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders PACKAGE › Review: the thread, filtered by version, with the reply box.
 *
 * @param props - See {@link IReviewViewProps}.
 */
export const ReviewView: React.FC<IReviewViewProps> = ({ host, app, readOnly }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	// null = first load in flight; [] = loaded and empty.
	const [history, setHistory] = useState<AppHistoryEntry[] | null>(null);
	const [versions, setVersions] = useState<AppVersionInfo[]>([]);
	const [loadError, setLoadError] = useState('');
	const [filter, setFilter] = useState<VersionFilter>('all');

	// ── Reply state ──────────────────────────────────────────────────────
	const [reply, setReply] = useState('');
	const [sending, setSending] = useState(false);
	const [replyError, setReplyError] = useState('');

	// ── Build-log viewer (opened from a failed event's button) ───────────
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

	/** Batched refresh: the history stream and the version rail. */
	const refresh = useCallback(async (): Promise<void> => {
		setLoadError('');
		try {
			const [h, v] = await Promise.all([host.loadHistory?.() ?? Promise.resolve([]), host.listVersions?.() ?? Promise.resolve([])]);
			setHistory(h);
			setVersions(v);
		} catch (e) {
			setHistory((prev) => prev ?? []);
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, [host]);

	// [host]-keyed: the VSCode adapter re-mints on account changes (verdict
	// pushes included), so this ALSO serves as the live-refresh trigger.
	useEffect(() => {
		void refresh();
	}, [refresh]);

	// A deploy's server build failing or succeeding lands as build ticks, not
	// as an account change; a terminal tick re-pulls the rail so the failed
	// verdict joins the stream.
	const [buildTicks, setBuildTicks] = useState<Record<number, string>>({});
	useEffect(() => host.subscribeBuildStatus?.((tick: BuildStatusTick) => {
		if (tick.version == null) return;
		setBuildTicks((prev) => ({ ...prev, [tick.version as number]: tick.status }));
		if (tick.status === '' || tick.status === 'failed') void refresh();
	}), [host.subscribeBuildStatus, refresh]);

	// Deployment changes of this app from ANY session in the org: re-fetch.
	useEffect(() => host.subscribeDeployChanged?.(() => void refresh()), [host, refresh]);

	// The rail's build verdict per version, for the timeline join: a server
	// build failure never writes a history row (the worker stamps the
	// ARTIFACT), so without this join a failed deploy reads healthy.
	const buildByVersion = useMemo(() => {
		const map = new Map<number, 'ok' | 'failed' | 'running'>();
		for (const v of versions) {
			const word = buildTicks[v.registryVersion];
			map.set(v.registryVersion, buildStateOf(word === undefined ? v : { ...v, buildStatus: word === '' ? 'ok' : word }));
		}
		return map;
	}, [versions, buildTicks]);

	// The version filter: every version the thread or the rail knows.
	const versionOptions = useMemo(() => {
		const known = new Set<number>(versions.map((v) => v.registryVersion));
		for (const entry of history ?? []) if (entry.version != null) known.add(entry.version);
		return [...known].sort((a, b) => b - a);
	}, [versions, history]);
	const visible = useMemo(() => (history ?? []).filter((entry) => filter === 'all' || entry.version === filter), [history, filter]);

	// Keep the stream pinned to its newest entry on every (re)load.
	const chatRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = chatRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [visible]);

	/** Send the reply, then reload so the row renders from the server's serialization. */
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
			{loadError ? (
				<div style={styles.loadBanner}>
					<Banner variant="info">Not connected to a RocketRide server: {loadError}. The thread appears here once connected.</Banner>
				</div>
			) : null}
			<div style={styles.filterRow}>
				<span style={styles.filterLabel}>Store review</span>
				<ToggleGroup
					options={[{ id: 'all', label: 'All versions' }, ...versionOptions.map((v) => ({ id: String(v), label: `v${v}` }))]}
					value={filter === 'all' ? 'all' : String(filter)}
					onChange={(id: string) => setFilter(id === 'all' ? 'all' : Number(id))}
				/>
			</div>
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
						) : visible.length === 0 ? (
							<EmptyState title="Nothing yet" description={filter === 'all' ? 'Deploys, publishes, review verdicts, and reviewer messages appear here once the app is on the server.' : `Nothing has happened to v${filter} yet.`} />
						) : (
							<div style={styles.stream}>
								<div style={styles.streamRail} />
								{visible.map((entry) => {
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
									const actor = entry.actor?.display || entry.actor?.email || '';
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
											{buildFailed ? <div style={styles.tlFail}>the server build failed, so this version can never serve</div> : null}
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
						<div style={styles.replyHint}>Replying is not wired up on this host yet, so the thread is read-only here.</div>
					)}
				</Card>
			</div>

			{logFor !== null && (
				<Modal
					title={`v${logFor} build log`}
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

ReviewView.displayName = 'ReviewView';
