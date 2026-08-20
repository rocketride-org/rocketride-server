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
// DEPLOY VIEW — versions rail + "Where this app is live"
// =============================================================================

/**
 * The DEPLOY view (the centerpiece): Deploy snapshots an immutable version
 * (author, time, sha, commit-style message); Publish pins a rung to one —
 * the single verb covering first publish, update, promote, and rollback
 * ("repoint, never rebuild").
 *
 * Layout per the v3 mockup: a horizontal rail of version cards headed by a
 * dashed "+ Deploy" card, then the "Where this app is live" reverse index
 * (rung → pinned version → state → audience → time). Data arrives through
 * the host adapter; hosts that have not wired deploy yet get teaching empty
 * states instead of dead chrome.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmDialog, EmptyState, InputField, Modal, StatusBadge } from 'shell';
import type { AppSummary, AppVersionInfo, BuildStatusTick, IAppBuilderHost, RungPin } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DeployView} component. */
export interface IDeployViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown (header facts). */
	app: AppSummary;
	/** Render everything non-interactive (namespace mismatch gating). */
	readOnly?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		overflow: 'auto',
		height: '100%',
	},
	head: {
		padding: '18px 26px 0',
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
	dialogHint: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginBottom: 10,
		lineHeight: 1.5,
	},
	sectLabel: {
		padding: '18px 26px 8px',
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: '0.06em',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
	},
	sectMicro: {
		fontWeight: 400,
		textTransform: 'none',
		letterSpacing: 0,
		color: 'var(--rr-text-disabled)',
		marginLeft: 8,
	},
	// The server build ticker beside the state badge: one small live word
	// ('uploaded' → 'installing' → … ), cleared by the server on success.
	buildTick: {
		fontSize: 11,
		fontStyle: 'italic',
		color: 'var(--rr-text-secondary)',
		marginLeft: 6,
		whiteSpace: 'nowrap',
	},
	// The failed badge is a DOOR (click opens the build log) — cursor and
	// title carry the affordance; the badge itself stays the stock chip.
	failedBadgeWrap: {
		cursor: 'pointer',
		display: 'inline-flex',
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
	rail: {
		display: 'flex',
		gap: 12,
		padding: '0 26px',
		overflowX: 'auto',
		alignItems: 'stretch',
	},
	card: {
		minWidth: 225,
		maxWidth: 250,
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		background: 'var(--rr-bg-paper)',
		padding: '13px 15px',
		boxShadow: '0 1px 3px rgba(30,40,55,0.06)',
		flexShrink: 0,
		// Column layout so the action row can pin to the card's BOTTOM —
		// cards vary in content (message, chip count) but the rail stretches
		// them to one height, and ragged mid-card buttons read as clutter.
		display: 'flex',
		flexDirection: 'column',
	},
	cardVersion: {
		fontSize: 15,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	},
	cardWho: {
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		marginTop: 5,
	},
	cardWhen: {
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	},
	cardMsg: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
		marginTop: 5,
	},
	chips: {
		display: 'flex',
		gap: 5,
		flexWrap: 'wrap',
		marginTop: 9,
		minHeight: 20,
	},
	cardAction: {
		// auto margin pins the buttons to the card bottom (see card).
		marginTop: 'auto',
		paddingTop: 10,
		display: 'flex',
		gap: 6,
		flexWrap: 'wrap',
		alignItems: 'center',
	},
	publishCard: {
		minWidth: 225,
		maxWidth: 250,
		border: '1.5px dashed var(--rr-border-hover)',
		borderRadius: 8,
		background: 'var(--rr-bg-paper)',
		padding: '13px 15px',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		gap: 6,
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	},
	publishPlus: {
		fontSize: 20,
		color: 'var(--rr-brand)',
	},
	publishTitle: {
		fontSize: 13,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	},
	publishHint: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
	},
	miniBtn: {
		padding: '4px 11px',
		fontSize: 11.5,
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border-hover)',
		borderRadius: 4,
		color: 'var(--rr-color-secondary)',
		fontWeight: 600,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	livePanel: {
		margin: '20px 26px 30px',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		overflow: 'hidden',
		background: 'var(--rr-bg-paper)',
	},
	liveHead: {
		padding: '11px 16px',
		fontSize: 13,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-surface-alt)',
		borderBottom: '1px solid var(--rr-border)',
	},
	liveRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '11px 16px',
		borderTop: '1px solid var(--rr-bg-widget-header)',
		fontSize: 12.5,
	},
	liveRung: {
		width: 190,
		flexShrink: 0,
		color: 'var(--rr-text-primary)',
		fontWeight: 700,
	},
	liveHandle: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginLeft: 6,
		fontWeight: 400,
	},
	// The package.json semver pill riding beside v<registry> — ONE format
	// shared by the version cards and the where-live rows.
	versionPill: {
		fontSize: 11,
		fontWeight: 700,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		padding: '2px 9px',
		borderRadius: 10,
		border: '1.5px solid var(--rr-color-secondary)',
		color: 'var(--rr-color-secondary)',
		marginLeft: 8,
		verticalAlign: 'middle',
	},
	// The v<registry> half of the shared format on where-live rows.
	liveVersionText: {
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	},
	liveAudience: {
		flex: 1,
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
	},
	// Pipe-pattern state text on where-live rows: a colored dot + word.
	liveStateOk: {
		fontSize: 11.5,
		fontWeight: 600,
		color: 'var(--rr-color-success)',
		whiteSpace: 'nowrap',
	},
	liveStateWarn: {
		fontSize: 11.5,
		fontWeight: 600,
		color: 'var(--rr-color-warning)',
		whiteSpace: 'nowrap',
	},
	liveWhen: {
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
		whiteSpace: 'nowrap',
	},
	liveFoot: {
		padding: '10px 16px 12px',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.6,
		borderTop: '1px solid var(--rr-bg-widget-header)',
		background: 'var(--rr-bg-surface-alt)',
	},
	emptyWrap: {
		padding: '10px 26px 30px',
	},
	pickBtn: {
		padding: '4px 10px',
		fontSize: 11.5,
		fontWeight: 600,
		background: 'var(--rr-brand)',
		color: 'var(--rr-text-on-brand, #ffffff)',
		border: '1px solid transparent',
		borderRadius: 4,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	// "Publish v<N> to…" audience rows (the pipe deploy dialog's picker
	// pattern): full-width row buttons, current pin state right-aligned.
	pubRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		width: '100%',
		padding: '10px 14px',
		marginBottom: 8,
		fontSize: 12.5,
		fontWeight: 600,
		textAlign: 'left',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		cursor: 'pointer',
	},
	// An audience the version's review state does not allow (Public before
	// 'ready') — visible so the ladder is learnable, disabled so the server
	// never has to bounce it.
	pubRowOff: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		width: '100%',
		padding: '10px 14px',
		marginBottom: 8,
		fontSize: 12.5,
		fontWeight: 600,
		textAlign: 'left',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-secondary)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		cursor: 'not-allowed',
		opacity: 0.55,
	},
	pubRowState: {
		marginLeft: 'auto',
		fontSize: 11.5,
		fontWeight: 400,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	// Per-pin soft-remove on the where-live rows.
	liveRemove: {
		padding: '3px 10px',
		fontSize: 11,
		fontWeight: 600,
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	// "Register as a developer" banner — shown until the org holds a developerId.
	devBanner: {
		margin: '14px 26px 0',
		padding: '12px 16px',
		border: '1px solid var(--rr-color-warning)',
		borderRadius: 8,
		background: 'rgba(232,185,49,0.10)',
	},
	devBannerText: {
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.5,
	},
	devBannerRow: {
		display: 'flex',
		gap: 8,
		marginTop: 10,
		alignItems: 'center',
	},
	devInput: {
		flex: '0 1 260px',
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		padding: '5px 10px',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
	},
	devError: {
		marginTop: 8,
		fontSize: 12,
		color: 'var(--rr-color-error)',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/** Uppercase audience chip from a pin — the pipe deploy card's pattern:
 * chips NAME the audiences serving this version (ME / <TEAM NAME> / STORE),
 * never a generic kind. */
function chipLabelOf(pin: RungPin): string {
	if (pin.rung === 'personal') return 'ME';
	if (pin.rung === 'public') return 'STORE';
	const name = pin.handle.startsWith('@team/') ? pin.handle.slice('@team/'.length) : pin.handle;
	return name.toUpperCase();
}

/** Per-version review-state badge (the deployment's review lifecycle). */
const STATE_BADGE: Record<NonNullable<AppVersionInfo['state']>, { variant: 'muted' | 'info' | 'success' | 'warning' | 'error'; label: string }> = {
	private: { variant: 'muted', label: 'draft' },
	submit: { variant: 'warning', label: 'in review' },
	ready: { variant: 'success', label: 'ready' },
	rejected: { variant: 'error', label: 'rejected' },
	failed: { variant: 'error', label: 'failed' },
};

/**
 * The version's effective server-build word: the live ticker wins while the
 * session holds one; otherwise the rail row's persisted buildStatus — so a
 * failed build stays visible across panel reloads, not just while the tick
 * that announced it is remembered. '' = servable ('ok' and legacy '' both).
 *
 * @param v - The rail entry.
 * @param ticks - The live ticker words by registry version.
 * @returns '' when servable, 'failed', or the in-flight lifecycle word.
 */
function buildWordOf(v: AppVersionInfo, ticks: Record<number, string>): string {
	const live = ticks[v.registryVersion];
	if (live !== undefined) return live;
	const word = v.buildStatus ?? '';
	return word === 'ok' ? '' : word;
}

/** Renders a unix-seconds timestamp as a compact local date/time. */
function formatWhen(unixSeconds?: number): string {
	if (!unixSeconds) return '';
	try {
		return new Date(unixSeconds * 1000).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	} catch {
		return '';
	}
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the DEPLOY view: version rail + where-live reverse index.
 *
 * @param props - See {@link IDeployViewProps}.
 */
// Cross-mount cache so re-selecting the DEPLOY tab paints the rail instantly
// (stale-while-revalidate): the strip shows the last-known versions/pins the
// moment the view mounts, then refresh() updates them in the background. Keyed
// by app id.
const railCache = new Map<string, { versions: AppVersionInfo[] | null; pins: RungPin[] | null }>();

export const DeployView: React.FC<IDeployViewProps> = ({ host, app, readOnly }) => {
	// ── Data — loaded through the host adapter, seeded from the cache ─────
	const [versions, setVersions] = useState<AppVersionInfo[] | null>(() => railCache.get(app.id)?.versions ?? null);
	const [pins, setPins] = useState<RungPin[] | null>(() => railCache.get(app.id)?.pins ?? null);
	// The version whose "Publish to…" audience dialog is open (null = none).
	const [publishFor, setPublishFor] = useState<AppVersionInfo | null>(null);
	// The caller's team roster for the publish dialog (null = not loaded).
	const [teams, setTeams] = useState<Array<{ id: string; name: string }> | null>(null);
	// The pin awaiting soft-remove confirmation (null = none).
	const [removePin, setRemovePin] = useState<RungPin | null>(null);
	// Deploy-message dialog (stock Modal + input — window.prompt is disabled in
	// the VSCode webview). An empty comment is allowed (it is optional).
	const [deployOpen, setDeployOpen] = useState(false);
	const [deployMessage, setDeployMessage] = useState('');
	const [deployBusy, setDeployBusy] = useState(false);
	// Server rejection shown INSIDE the deploy dialog (a silent bounce-back
	// reads as "nothing happened").
	const [deployError, setDeployError] = useState('');
	// Failures from the dialog-less actions (publish/team/submit) — surfaced
	// as a strip above the rail; cleared by the next action or a refresh.
	const [actionError, setActionError] = useState('');
	// Developer registration: '' = org not a developer yet; null = unknown/loading.
	const [developerId, setDeveloperId] = useState<string | null>(null);
	const [regSlug, setRegSlug] = useState('');
	const [regBusy, setRegBusy] = useState(false);
	const [regError, setRegError] = useState('');
	// The server build ticker: registryVersion -> the current display word
	// ('uploaded' → 'preparing' → 'installing' → …); '' from the server
	// clears the entry (success — nothing left to say).
	const [buildTicks, setBuildTicks] = useState<Record<number, string>>({});
	// The build-log viewer: which version's log is open (null = closed) and
	// its text (null = loading).
	const [logFor, setLogFor] = useState<AppVersionInfo | null>(null);
	const [logText, setLogText] = useState<string | null>(null);

	/**
	 * Load versions + pins. The two queries run INDEPENDENTLY so the versions
	 * strip renders the moment the rail returns, without waiting on the
	 * separate (and slower) where-live query — the old Promise.all gated the
	 * strip on both. Each result write-throughs to the cross-mount cache so a
	 * later re-select paints instantly. Still awaits both, so post-action
	 * callers (deploy/publish/submit) see the settled data.
	 */
	const refresh = useCallback(async (): Promise<void> => {
		const patch = (p: Partial<{ versions: AppVersionInfo[]; pins: RungPin[] }>) => {
			railCache.set(app.id, { versions: null, pins: null, ...railCache.get(app.id), ...p });
		};
		const vP = Promise.resolve(host.listVersions?.() ?? [])
			.then((v) => {
				setVersions(v);
				patch({ versions: v });
			})
			.catch((e) => {
				console.log('[appdev] listVersions failed:', e);
				setVersions([]);
			});
		const pP = Promise.resolve(host.getWhereLive?.() ?? [])
			.then((p) => {
				setPins(p);
				patch({ pins: p });
			})
			.catch((e) => {
				console.log('[appdev] whereLive failed:', e);
				setPins([]);
			});
		await Promise.all([vP, pP]);
	}, [host, app.id]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// The server build ticker (apaevt_build_status via the host): keep the
	// latest word per version for the cards, and re-fetch the rail on the
	// TERMINAL ticks — 'uploaded' (a new version row exists), '' (success:
	// the version just became servable), 'failed' (errors landed on the
	// rail row). Intermediate words are display-only.
	useEffect(() => {
		if (!host.subscribeBuildStatus) return;
		return host.subscribeBuildStatus((tick: BuildStatusTick) => {
			if (typeof tick.version !== 'number') return;
			const version = tick.version;
			setBuildTicks((prev) => {
				const next = { ...prev };
				if (tick.status === '') delete next[version];
				else next[version] = tick.status;
				return next;
			});
			if (tick.status === '' || tick.status === 'failed' || tick.status === 'uploaded') void refresh();
		});
	}, [host, refresh]);

	// Load the org's developer id (null when the host can't report it — no banner).
	useEffect(() => {
		if (!host.getDeveloperId) {
			setDeveloperId(null);
			return;
		}
		void host
			.getDeveloperId()
			.then(setDeveloperId)
			.catch(() => setDeveloperId(null));
	}, [host]);

	/** Claim the org's developer id slug (org.admin, self-service). */
	const onRegister = useCallback(async (): Promise<void> => {
		if (!host.registerDeveloper || !regSlug.trim()) return;
		setRegBusy(true);
		setRegError('');
		try {
			const assigned = await host.registerDeveloper(regSlug.trim());
			setDeveloperId(assigned);
			setRegSlug('');
		} catch (e) {
			setRegError(e instanceof Error ? e.message : String(e));
		} finally {
			setRegBusy(false);
		}
	}, [host, regSlug]);

	/** Deploy: open the stock message dialog (window.prompt is unavailable in
	 * the webview). The snapshot itself happens in confirmDeploy. */
	const onDeployBuild = useCallback((): void => {
		if (!host.deploy) return;
		setDeployMessage('');
		setDeployError('');
		setDeployOpen(true);
	}, [host]);

	/** Snapshot the app source as the next immutable registry version
	 * ("Deploy" = copy code to the server). Binds nothing — that is the
	 * separate publish step. A rejection stays IN the dialog so the
	 * developer sees the server's reason instead of a silent bounce. */
	const confirmDeploy = useCallback(async (): Promise<void> => {
		if (!host.deploy) return;
		setDeployBusy(true);
		setDeployError('');
		try {
			await host.deploy(deployMessage.trim());
			setDeployOpen(false);
			await refresh();
		} catch (e) {
			setDeployError(e instanceof Error ? e.message : String(e));
		} finally {
			setDeployBusy(false);
		}
	}, [host, deployMessage, refresh]);

	/** Open the build-log viewer for one version and fetch its log — the
	 * "failed" badge's click-through (the log is the ONLY home of build
	 * error detail; nothing rides the rail rows). */
	const openBuildLog = useCallback(
		(v: AppVersionInfo): void => {
			setLogFor(v);
			setLogText(null);
			if (!host.loadBuildLog) {
				setLogText('Build-log reading is not wired up on this host.');
				return;
			}
			void host
				.loadBuildLog(v.registryVersion)
				.then((text) => setLogText(text || 'No build log exists for this version.'))
				.catch((e) => setLogText(`Could not load the build log: ${e instanceof Error ? e.message : String(e)}`));
		},
		[host]
	);

	/** Open the "Publish v<N> to…" audience dialog (the pipe deploy dialog's
	 * picker pattern) and lazily load the team roster for its rows. */
	const openPublish = useCallback(
		(v: AppVersionInfo): void => {
			setPublishFor(v);
			if (teams === null && host.listTeams) {
				void host
					.listTeams()
					.then(setTeams)
					.catch(() => setTeams([]));
			}
		},
		[host, teams]
	);

	/** Publish: bind a version to the chosen audience — the one verb for
	 * first publish, update, promote, and rollback. @public needs the
	 * version approved (ready) first; the dialog gates that row. */
	const onPublishTo = useCallback(
		async (version: number, target: string): Promise<void> => {
			if (!host.publish) return;
			setPublishFor(null);
			setActionError('');
			try {
				await host.publish(version, target);
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			}
			await refresh();
		},
		[host, refresh]
	);

	/** Soft-remove one audience binding (the pin's handle IS the wire
	 * target) — the app stops serving there; republishing revives it. */
	const onRemovePin = useCallback(
		async (pin: RungPin): Promise<void> => {
			if (!host.removePublish) return;
			setActionError('');
			try {
				await host.removePublish(pin.handle);
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			}
			await refresh();
		},
		[host, refresh]
	);

	/** The dialog rows' current-state hint: what the audience serves now. */
	const pinStateOf = useCallback(
		(handle: string, v: AppVersionInfo): string => {
			const pin = (pins ?? []).find((p) => p.handle === handle);
			if (!pin) return 'not published';
			return pin.registryVersion === v.registryVersion ? `already on v${pin.registryVersion}` : `on v${pin.registryVersion}`;
		},
		[pins]
	);

	/** Submit a deployed version for public store review (private → submit). */
	const onSubmit = useCallback(
		async (version: number): Promise<void> => {
			if (!host.submitForReview) return;
			setActionError('');
			try {
				await host.submitForReview(version);
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			}
			await refresh();
		},
		[host, refresh]
	);

	/** Withdraw a pending review (submit → private) — the developer's own
	 * cancel; the version returns to draft with its Submit button. */
	const onWithdraw = useCallback(
		async (version: number): Promise<void> => {
			if (!host.withdrawReview) return;
			setActionError('');
			try {
				await host.withdrawReview(version);
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			}
			await refresh();
		},
		[host, refresh]
	);

	const deployWired = Boolean(host.listVersions || host.deploy);

	// Latest-only review: Submit renders solely on the newest non-'failed'
	// version (the server enforces the same rule) — review tracks current
	// work; older code that should ship is deployed again.
	const newestSubmittable = (versions ?? []).reduce((max, x) => (x.state !== 'failed' && x.registryVersion > max ? x.registryVersion : max), 0);

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose (the pipeline pattern) */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>Deploy immutable versions, then publish each to an audience — @me, a team, or the public store. Internal audiences serve instantly; the store gates every version on review.</div>
				{/* Failures from the dialog-less actions (publish/submit) land
				    here — otherwise they are invisible. */}
				{actionError ? <div style={styles.devError}>{actionError}</div> : null}
			</div>

			{!deployWired ? (
				<div style={styles.emptyWrap}>
					<EmptyState title="Publishing is not wired up yet" description="Once the deploy pipeline lands, published versions appear here as immutable cards with rung chips, and the reverse index below shows what runs where." />
				</div>
			) : (
				<>
					{host.registerDeveloper && !readOnly && developerId === '' && (
						<div style={styles.devBanner}>
							<div style={styles.devBannerText}>
								<strong>Register as a developer to deploy apps.</strong> Every app id is <code>&lt;developerId&gt;.&lt;name&gt;</code> — claim your organization&rsquo;s developer id (letters and underscores only) to publish under your own namespace.
							</div>
							<div style={styles.devBannerRow}>
								<input style={styles.devInput} placeholder="developer id (e.g. acme_labs)" value={regSlug} onChange={(e) => setRegSlug(e.target.value)} />
								<button style={styles.pickBtn} disabled={regBusy || !regSlug.trim()} onClick={() => void onRegister()}>
									{regBusy ? 'Registering…' : 'Register'}
								</button>
							</div>
							{regError ? <div style={styles.devError}>{regError}</div> : null}
						</div>
					)}
					{/* Published versions rail */}
					<div style={styles.sectLabel}>
						Published versions
						<span style={styles.sectMicro}>org registry · immutable · newest first</span>
					</div>
					<div style={styles.rail}>
						{host.deploy && !readOnly && (
							<div style={styles.publishCard} onClick={onDeployBuild}>
								<span style={styles.publishPlus}>+</span>
								<span style={styles.publishTitle}>Deploy</span>
								{/* While the zip is in flight the tile itself is the card —
								    the version row (and its 'uploaded' tick) exists only
								    once the server has accepted the upload. */}
								<span style={styles.publishHint}>{deployBusy ? 'uploading…' : 'snapshot the current build to the server'}</span>
							</div>
						)}
						{(versions ?? []).map((v) => {
							// The BUILD axis of this version — separate from the review
							// state: a 'private' draft whose server build failed can
							// never serve, must say so, and gets no action buttons.
							const buildWord = buildWordOf(v, buildTicks);
							const buildFailed = buildWord === 'failed';
							const servable = buildWord === '';
							return (
								<div key={v.registryVersion} style={styles.card}>
									{/* Registry int IS the version identity; the package.json
									    semver rides beside it in a pill — the same format the
									    where-live rows render. */}
									<div style={styles.cardVersion}>
										v{v.registryVersion}
										{v.version ? <span style={styles.versionPill}>{v.version}</span> : null}
									</div>
									<div style={styles.cardWho}>{v.author}</div>
									<div style={styles.cardWhen}>
										{formatWhen(v.publishedAt)}
										{v.sha ? ` · ${v.sha.slice(0, 8)}…` : ''}
									</div>
									{v.message ? <div style={styles.cardMsg}>&ldquo;{v.message}&rdquo;</div> : null}
									<div style={styles.chips}>
										{buildFailed ? (
											// The failure outranks the review state on the badge:
											// "draft" on an unservable version reads as healthy.
											// Clicking the badge opens the build log — the why.
											<span
												style={styles.failedBadgeWrap}
												role="button"
												tabIndex={0}
												title="Show the build log"
												onClick={() => openBuildLog(v)}
												onKeyDown={(e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														openBuildLog(v);
													}
												}}
											>
												<StatusBadge variant="error">failed</StatusBadge>
											</span>
										) : v.state && v.state in STATE_BADGE ? (
											<StatusBadge variant={STATE_BADGE[v.state].variant}>{STATE_BADGE[v.state].label}</StatusBadge>
										) : v.state ? (
											// STATE_BADGE is total over the typed union, but a state the
											// server adds later would be absent at runtime — render its raw
											// name as a muted chip rather than crash the row on undefined.
											<StatusBadge variant="muted">{v.state}</StatusBadge>
										) : null}
										{/* The server build lifecycle word beside the badge
										    ('uploaded' → 'installing' → …) — live ticks win, the
										    rail's persisted word covers reopened panels, and ''
										    (servable) renders nothing. Failure is the badge above. */}
										{!servable && !buildFailed ? <span style={styles.buildTick}>{buildWord}</span> : null}
										{/* Audience chips NAME who serves this version (the pipe
										    card's pattern) — derived from the where-live pins. */}
										{(pins ?? [])
											.filter((p) => p.registryVersion === v.registryVersion)
											.map((p) => (
												<StatusBadge key={p.rung + p.handle} variant={p.rung === 'public' ? 'info' : 'success'}>
													{chipLabelOf(p)}
												</StatusBadge>
											))}
									</div>
									{(host.publish || host.submitForReview) && !readOnly && (
										<div style={styles.cardAction}>
											{/* One primary action, like the pipe card's "Deploy to…" —
											    only legal moves render: publishing and review both
											    require a SERVABLE build (the server refuses otherwise),
											    internal publishing is open to any non-'failed' version,
											    and Submit exists solely on 'private' (the private→submit
											    edge; rejected/failed are terminal). */}
											{host.publish && servable && v.state !== 'failed' && (
												<button style={styles.miniBtn} onClick={() => openPublish(v)}>
													Publish to…
												</button>
											)}
											{host.submitForReview && servable && v.state === 'private' && v.registryVersion === newestSubmittable && (
												<button style={styles.miniBtn} onClick={() => void onSubmit(v.registryVersion)}>
													Submit for review
												</button>
											)}
											{host.withdrawReview && v.state === 'submit' && (
												<button style={styles.miniBtn} onClick={() => void onWithdraw(v.registryVersion)}>
													Withdraw
												</button>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>

					{/* Where this app is live — the reverse index */}
					<div style={styles.livePanel}>
						<div style={styles.liveHead}>Where this app is live</div>
						{(pins ?? []).length === 0 ? (
							<div style={styles.liveFoot}>Nothing is deployed yet — publish a version and deploy it to your personal rung to see it here.</div>
						) : (
							<>
								{(pins ?? []).map((p) => (
									<div key={p.rung + p.handle} style={styles.liveRow}>
										<div style={styles.liveRung}>
											{p.label}
											<span style={styles.liveHandle}>{p.handle}</span>
										</div>
										<span style={styles.liveVersionText}>
											v{p.registryVersion}
											{p.version ? <span style={styles.versionPill}>{p.version}</span> : null}
										</span>
										<span style={p.state === 'pending' ? styles.liveStateWarn : styles.liveStateOk}>&#9679; {p.state === 'pending' ? 'in review' : p.state}</span>
										<span style={styles.liveAudience}>
											{p.audience}
											{p.pendingVersion ? ` · v${p.pendingVersion} in review` : ''}
										</span>
										<span style={styles.liveWhen}>{p.deployedAt ? `deployed ${formatWhen(p.deployedAt)}` : ''}</span>
										{host.removePublish && !readOnly && (
											<button style={styles.liveRemove} onClick={() => setRemovePin(p)}>
												Remove
											</button>
										)}
									</div>
								))}
								<div style={styles.liveFoot}>Deploy pins a rung to an immutable version — first publish, update, promote, and rollback are all this one verb. Personal deploys land on your desktop automatically. Review gates every version on the store rung; internal rungs never wait.</div>
							</>
						)}
					</div>
				</>
			)}

			{/* ── Deploy-message dialog (stock Modal — window.prompt is
			    disabled inside the VSCode webview) ─────────────────────── */}
			{deployOpen && (
				<Modal
					title="Deploy a new version"
					onClose={() => setDeployOpen(false)}
					footer={
						<>
							<Button variant="secondary" disabled={deployBusy} onClick={() => setDeployOpen(false)}>
								Cancel
							</Button>
							<Button variant="primary" disabled={deployBusy} onClick={() => void confirmDeploy()}>
								{deployBusy ? 'Deploying…' : 'Deploy'}
							</Button>
						</>
					}
				>
					<div style={styles.dialogHint}>Packs the app source and ships it to the server as the next immutable version. Binds nothing — publish it to an audience afterwards.</div>
					<InputField placeholder="What changed? (optional comment)" value={deployMessage} onChange={(e) => setDeployMessage(e.target.value)} disabled={deployBusy} />
					{deployError ? <div style={styles.devError}>{deployError}</div> : null}
				</Modal>
			)}

			{/* ── Build-log viewer — the failed badge's click-through ────── */}
			{logFor && (
				<Modal
					title={`v${logFor.registryVersion}${logFor.version ? ` (${logFor.version})` : ''} build log`}
					// 80% of the pane: build-log lines are long — the stock 440px
					// box wraps them into porridge.
					width={Math.floor(window.innerWidth * 0.8)}
					onClose={() => setLogFor(null)}
					footer={
						<Button variant="secondary" onClick={() => setLogFor(null)}>
							Close
						</Button>
					}
				>
					<div style={styles.dialogHint}>The server&rsquo;s full build output for this version, phase by phase — the failure reason is at the end.</div>
					<pre style={styles.logPre}>{logText === null ? 'Loading build log…' : logText}</pre>
				</Modal>
			)}

			{/* ── "Publish v<N> to…" audience dialog (the pipe deploy dialog's
			    picker pattern: one row per audience, current state on the
			    right, choosing a row IS the action) ─────────────────────── */}
			{publishFor && (
				<Modal
					title={`Publish v${publishFor.registryVersion}${publishFor.version ? ` (${publishFor.version})` : ''} to…`}
					onClose={() => setPublishFor(null)}
					footer={
						<Button variant="secondary" onClick={() => setPublishFor(null)}>
							Cancel
						</Button>
					}
				>
					<div style={styles.dialogHint}>Points the chosen audience at this version — first publish, update, promote, and rollback are all this one pointer move. Internal audiences serve instantly; the store gates every version on review.</div>
					<button style={styles.pubRow} onClick={() => void onPublishTo(publishFor.registryVersion, '@me')}>
						Me<span style={styles.pubRowState}>{pinStateOf('@me', publishFor)}</span>
					</button>
					{(teams ?? []).map((t) => (
						<button key={t.id} style={styles.pubRow} onClick={() => void onPublishTo(publishFor.registryVersion, `@team/${t.id}`)}>
							{t.name}
							<span style={styles.pubRowState}>{pinStateOf(`@team/${t.name}`, publishFor)}</span>
						</button>
					))}
					{publishFor.state === 'ready' ? (
						<button style={styles.pubRow} onClick={() => void onPublishTo(publishFor.registryVersion, '@public')}>
							Public — the app store<span style={styles.pubRowState}>{pinStateOf('@public', publishFor)}</span>
						</button>
					) : (
						<button style={styles.pubRowOff} disabled title="The store needs an approved ('ready') version — submit it for review first">
							Public — the app store<span style={styles.pubRowState}>needs review approval</span>
						</button>
					)}
				</Modal>
			)}

			{/* ── Soft-remove confirmation for a where-live pin ─────────── */}
			{removePin && (
				<ConfirmDialog
					title={`Remove ${app.name} from ${removePin.label}?`}
					message={`Takes the app off ${removePin.handle}: it stops serving to that audience. This is a SOFT remove — every published version and the audit history survive, and publishing to ${removePin.handle} again revives it.`}
					confirmLabel="Remove"
					cancelLabel="Cancel"
					onConfirm={() => {
						const pin = removePin;
						setRemovePin(null);
						void onRemovePin(pin);
					}}
					onCancel={() => setRemovePin(null)}
				/>
			)}
		</div>
	);
};
