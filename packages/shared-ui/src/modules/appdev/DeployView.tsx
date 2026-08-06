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
 * The DEPLOY view (the centerpiece): Publish snapshots an immutable version
 * (author, time, sha, commit-style message); Deploy pins a rung to one —
 * the single verb covering first publish, update, promote, and rollback
 * ("repoint, never rebuild").
 *
 * Layout per the v3 mockup: a horizontal rail of version cards headed by a
 * dashed "+ Publish" card, then the "Where this app is live" reverse index
 * (rung → pinned version → state → audience → time). Data arrives through
 * the host adapter; hosts that have not wired deploy yet get teaching empty
 * states instead of dead chrome.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../../components/empty-state/EmptyState';
import { StatusBadge } from '../../components/status-badge/StatusBadge';
import type { AppSummary, AppVersionInfo, IAppBuilderHost, RungKind, RungPin } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DeployView} component. */
export interface IDeployViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown (header facts). */
	app: AppSummary;
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
		marginTop: 10,
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
	pin: {
		fontSize: 11,
		fontWeight: 700,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		padding: '2px 9px',
		borderRadius: 10,
		border: '1.5px solid var(--rr-color-secondary)',
		color: 'var(--rr-color-secondary)',
	},
	liveAudience: {
		flex: 1,
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
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
};

// =============================================================================
// HELPERS
// =============================================================================

/** Rung chip label per rung kind (the mockup's uppercase chips). */
const RUNG_CHIP_LABEL: Record<RungKind, string> = {
	personal: 'PERSONAL',
	team: 'TEAM',
	org: 'ORG',
	public: 'STORE',
};

/** Renders a unix-seconds timestamp as a compact local date/time. */
function formatWhen(unixSeconds?: number): string {
	if (!unixSeconds) return '';
	try {
		return new Date(unixSeconds * 1000).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
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
export const DeployView: React.FC<IDeployViewProps> = ({ host, app }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	const [versions, setVersions] = useState<AppVersionInfo[] | null>(null);
	const [pins, setPins] = useState<RungPin[] | null>(null);

	/** Loads (or reloads) versions + pins; absent loaders resolve empty. */
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const [v, p] = await Promise.all([
				host.listVersions?.() ?? Promise.resolve([]),
				host.getWhereLive?.() ?? Promise.resolve([]),
			]);
			setVersions(v);
			setPins(p);
		} catch (e) {
			console.log('[appdev] deploy refresh failed:', e);
			setVersions([]);
			setPins([]);
		}
	}, [host]);

	useEffect(() => { void refresh(); }, [refresh]);

	/** Publish flow: message prompt is host-side later; v1 uses a simple prompt. */
	const onPublish = useCallback(async (): Promise<void> => {
		if (!host.publish) return;
		// Commit-style message is part of the verb (the version card is the
		// unit of UI) — collected inline until the publish dialog lands.
		const message = window.prompt('Publish message (what changed):') ?? '';
		if (!message) return;
		await host.publish(message);
		await refresh();
	}, [host, refresh]);

	/** Deploy flow: target prompt until the "Deploy to…" picker lands. */
	const onDeploy = useCallback(async (version: string): Promise<void> => {
		if (!host.deploy) return;
		const target = window.prompt('Deploy target (@user, @team/<name>, @org):') ?? '';
		if (!target) return;
		await host.deploy(version, target);
		await refresh();
	}, [host, refresh]);

	const deployWired = Boolean(host.listVersions || host.publish);

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose (the pipeline pattern) */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>
					Deploy — publish immutable versions and pin them to your rungs: personal, team, org, store.
					No review needed off the store.
				</div>
			</div>

			{!deployWired ? (
				<div style={styles.emptyWrap}>
					<EmptyState
						title="Publishing is not wired up yet"
						description="Once the deploy pipeline lands, published versions appear here as immutable cards with rung chips, and the reverse index below shows what runs where."
					/>
				</div>
			) : (
				<>
					{/* Published versions rail */}
					<div style={styles.sectLabel}>
						Published versions
						<span style={styles.sectMicro}>org registry · immutable · newest first</span>
					</div>
					<div style={styles.rail}>
						{host.publish && (
							<div style={styles.publishCard} onClick={() => void onPublish()}>
								<span style={styles.publishPlus}>+</span>
								<span style={styles.publishTitle}>Publish</span>
								<span style={styles.publishHint}>snapshot the current build</span>
							</div>
						)}
						{(versions ?? []).map((v) => (
							<div key={v.version} style={styles.card}>
								<div style={styles.cardVersion}>v{v.version}</div>
								<div style={styles.cardWho}>{v.author}</div>
								<div style={styles.cardWhen}>
									{formatWhen(v.publishedAt)}{v.sha ? ` · ${v.sha.slice(0, 8)}…` : ''}
								</div>
								{v.message ? <div style={styles.cardMsg}>&ldquo;{v.message}&rdquo;</div> : null}
								<div style={styles.chips}>
									{v.rungs.map((r) => (
										<StatusBadge key={r} variant={r === 'public' ? 'info' : 'success'}>
											{RUNG_CHIP_LABEL[r]}
										</StatusBadge>
									))}
								</div>
								{host.deploy && (
									<div style={styles.cardAction}>
										<button style={styles.miniBtn} onClick={() => void onDeploy(v.version)}>Deploy to…</button>
									</div>
								)}
							</div>
						))}
					</div>

					{/* Where this app is live — the reverse index */}
					<div style={styles.livePanel}>
						<div style={styles.liveHead}>Where this app is live</div>
						{(pins ?? []).length === 0 ? (
							<div style={styles.liveFoot}>
								Nothing is deployed yet — publish a version and deploy it to your personal rung to see it here.
							</div>
						) : (
							<>
								{(pins ?? []).map((p) => (
									<div key={p.rung + p.handle} style={styles.liveRow}>
										<div style={styles.liveRung}>
											{p.label}
											<span style={styles.liveHandle}>{p.handle}</span>
										</div>
										<span style={styles.pin}>v{p.version}</span>
										<StatusBadge variant={p.state === 'pending' ? 'warning' : 'success'}>
											{p.state === 'pending' ? 'in review' : p.state}
										</StatusBadge>
										<span style={styles.liveAudience}>
											{p.audience}
											{p.pendingVersion ? ` · v${p.pendingVersion} in review` : ''}
										</span>
										<span style={styles.liveWhen}>
											{p.deployedAt ? `deployed ${formatWhen(p.deployedAt)}` : ''}
										</span>
									</div>
								))}
								<div style={styles.liveFoot}>
									Deploy pins a rung to an immutable version — first publish, update, promote, and rollback
									are all this one verb. Personal deploys land on your desktop automatically. Review gates
									every version on the store rung; internal rungs never wait.
								</div>
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
};
