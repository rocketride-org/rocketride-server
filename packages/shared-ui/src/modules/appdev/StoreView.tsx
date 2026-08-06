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
// STORE VIEW — listing, pre-flight, per-version review history
// =============================================================================

/**
 * The STORE view — the only paperwork: the public listing (with the pricing
 * PROPOSAL that goes live on approval), the pre-flight checklist, submission,
 * and the per-version review history. Personal, team, and org deploys never
 * touch this tab; every version deployed to the public rung is reviewed.
 *
 * Pure view logic over the host adapter: hosts that have not wired the
 * marketplace loaders yet get teaching empty states.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/button/Button';
import { Card } from '../../components/card/Card';
import { EmptyState } from '../../components/empty-state/EmptyState';
import { InputField } from '../../components/input-field/InputField';
import { StatusBadge } from '../../components/status-badge/StatusBadge';
import type { AppSummary, IAppBuilderHost, ListingDraft, PreflightCheck, ReviewTimelineItem } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link StoreView} component. */
export interface IStoreViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
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
	grid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 16,
		alignItems: 'start',
		margin: '16px 26px 30px',
		maxWidth: 1060,
	},
	rightCol: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	formRow: {
		marginBottom: 11,
	},
	formLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginBottom: 4,
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
	},
	formStatic: {
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '6px 10px',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		color: 'var(--rr-text-primary)',
	},
	formSelect: {
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '6px 10px',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		width: '100%',
	},
	formArea: {
		background: 'var(--rr-bg-input)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		padding: '6px 10px',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		width: '100%',
		minHeight: 64,
		lineHeight: 1.5,
		resize: 'vertical',
		fontFamily: 'inherit',
	},
	form2col: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 10,
	},
	tierTable: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 12,
	},
	tierTh: {
		textAlign: 'left',
		color: 'var(--rr-text-disabled)',
		fontSize: 10.5,
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
		padding: '4px 8px 6px 0',
		fontWeight: 600,
	},
	tierTd: {
		padding: '5px 8px 5px 0',
		borderTop: '1px solid var(--rr-bg-widget-header)',
		color: 'var(--rr-text-primary)',
	},
	actions: {
		display: 'flex',
		gap: 10,
		marginTop: 14,
		alignItems: 'center',
	},
	actionNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
	},
	checkRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '6px 0',
		fontSize: 12.5,
		borderTop: '1px solid var(--rr-bg-widget-header)',
	},
	checkRowFirst: {
		borderTop: 'none',
	},
	checkMark: {
		width: 16,
		height: 16,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 10,
		fontWeight: 800,
		flexShrink: 0,
	},
	checkText: {
		flex: 1,
		color: 'var(--rr-text-primary)',
	},
	checkNote: {
		color: 'var(--rr-text-disabled)',
		fontSize: 11.5,
	},
	timeline: {
		position: 'relative',
		paddingLeft: 22,
	},
	timelineRail: {
		position: 'absolute',
		left: 7,
		top: 6,
		bottom: 6,
		width: 1,
		background: 'var(--rr-border)',
	},
	tlItem: {
		position: 'relative',
		padding: '6px 0 12px',
	},
	tlDot: {
		position: 'absolute',
		left: -20,
		top: 10,
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
	tlNote: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
		lineHeight: 1.5,
	},
	rejectQuote: {
		borderLeft: '3px solid var(--rr-color-error)',
		background: 'rgba(244,67,54,0.08)',
		padding: '8px 12px',
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		borderRadius: '0 4px 4px 0',
		marginTop: 6,
		lineHeight: 1.55,
	},
	emptyWrap: {
		padding: '16px 26px 30px',
		maxWidth: 640,
	},
};

// Check-mark palettes per state (light tints of the semantic tokens)
const CHECK_PALETTE: Record<PreflightCheck['state'], { bg: string; fg: string; glyph: string }> = {
	pass: { bg: 'rgba(34,153,84,0.14)', fg: 'var(--rr-color-success)', glyph: '✓' },
	warn: { bg: 'rgba(232,185,49,0.18)', fg: 'var(--rr-color-warning)', glyph: '!' },
	fail: { bg: 'rgba(244,67,54,0.14)', fg: 'var(--rr-color-error)', glyph: '✕' },
};

// Timeline dot colour per item state
const TL_DOT_COLOR: Record<ReviewTimelineItem['state'], string> = {
	done: 'var(--rr-color-success)',
	pending: 'var(--rr-color-warning)',
	rejected: 'var(--rr-color-error)',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the STORE view: listing card + pre-flight/submission + review
 * history.
 *
 * @param props - See {@link IStoreViewProps}.
 */
export const StoreView: React.FC<IStoreViewProps> = ({ host, app }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	const [draft, setDraft] = useState<ListingDraft | null>(null);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	const [history, setHistory] = useState<ReviewTimelineItem[]>([]);
	const [saving, setSaving] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	/** Initial load: listing draft, pre-flight results, review history. */
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const [d, c, h] = await Promise.all([
				host.loadListing?.() ?? Promise.resolve(null),
				host.runPreflight?.() ?? Promise.resolve([]),
				host.loadReviewHistory?.() ?? Promise.resolve([]),
			]);
			// Seed an empty draft from the app facts when no record exists yet
			setDraft(d ?? { appId: app.id, mode: 'free', name: app.name, description: app.description ?? '', tiers: [] });
			setChecks(c);
			setHistory(h);
		} catch (e) {
			console.log('[appdev] store refresh failed:', e);
		}
	}, [host, app.id, app.name, app.description]);

	useEffect(() => { void refresh(); }, [refresh]);

	/** Persist the listing draft through the host. */
	const onSave = useCallback(async (): Promise<void> => {
		if (!draft || !host.saveListing) return;
		setSaving(true);
		try { await host.saveListing(draft); } finally { setSaving(false); }
	}, [draft, host]);

	/** Submit the current version for public review. */
	const onSubmit = useCallback(async (): Promise<void> => {
		if (!host.submitForReview) return;
		setSubmitting(true);
		try {
			await host.submitForReview(app.version ?? '');
			await refresh();
		} finally { setSubmitting(false); }
	}, [host, app.version, refresh]);

	// Marketplace not wired at all: one teaching empty state, no dead forms
	if (!host.loadListing && !host.runPreflight && !host.submitForReview) {
		return (
			<div style={styles.wrap}>
				<div style={styles.head}>
					<div style={styles.h1}>{app.name}</div>
					<div style={styles.sub}>
						Store — the public listing, pre-flight checks, and platform review. Only needed to
						distribute on the App Store; personal, team, and org deploys skip all of this.
					</div>
				</div>
				<div style={styles.emptyWrap}>
					<EmptyState
						title="Store publishing is not wired up yet"
						description="Once the marketplace flows land, the listing form, pre-flight checks, and the per-version review timeline appear here."
					/>
				</div>
			</div>
		);
	}

	const canSubmit = checks.length > 0 && !checks.some((c) => c.state === 'fail');

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>
					Store — the public listing, pre-flight checks, and platform review. Only needed to
					distribute on the App Store; personal, team, and org deploys skip all of this. Every
					public version is reviewed.
				</div>
			</div>

			<div style={styles.grid}>
				{/* ── Left: the listing card ─────────────────────────────── */}
				<Card
					header="Store listing"
					headerActions={<StatusBadge variant={app.status === 'live' ? 'info' : 'muted'}>{app.status}</StatusBadge>}
				>
					<div style={styles.form2col}>
						<div style={styles.formRow}>
							<div style={styles.formLabel}>App ID</div>
							<div style={styles.formStatic}>{draft?.appId ?? app.id}</div>
						</div>
						<div style={styles.formRow}>
							<div style={styles.formLabel}>Mode</div>
							<select
								style={styles.formSelect}
								value={draft?.mode ?? 'free'}
								onChange={(e) => setDraft((d) => d ? { ...d, mode: e.target.value as ListingDraft['mode'] } : d)}
							>
								<option value="free">Free</option>
								<option value="subscription">Subscription</option>
								<option value="paywall">Paywall</option>
							</select>
						</div>
					</div>
					<div style={styles.formRow}>
						<div style={styles.formLabel}>Display name</div>
						<InputField
							value={draft?.name ?? ''}
							onChange={(e) => setDraft((d) => d ? { ...d, name: e.target.value } : d)}
						/>
					</div>
					<div style={styles.formRow}>
						<div style={styles.formLabel}>Description</div>
						<textarea
							style={styles.formArea}
							value={draft?.description ?? ''}
							onChange={(e) => setDraft((d) => d ? { ...d, description: e.target.value } : d)}
						/>
					</div>
					{(draft?.mode ?? 'free') !== 'free' && (
						<div style={styles.formRow}>
							<div style={styles.formLabel}>Pricing (proposal — live on approval)</div>
							<table style={styles.tierTable}>
								<thead>
									<tr>
										<th style={styles.tierTh}>Tier</th>
										<th style={styles.tierTh}>Price</th>
										<th style={styles.tierTh}>Interval</th>
										<th style={styles.tierTh}>Credits</th>
									</tr>
								</thead>
								<tbody>
									{(draft?.tiers ?? []).map((t) => (
										<tr key={t.nickname}>
											<td style={styles.tierTd}>{t.nickname}</td>
											<td style={styles.tierTd}>{(t.amountCents / 100).toLocaleString(undefined, { style: 'currency', currency: t.currency || 'USD' })}</td>
											<td style={styles.tierTd}>{t.interval}</td>
											<td style={styles.tierTd}>{t.credits?.toLocaleString() ?? '—'}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{host.saveListing && (
						<div style={styles.actions}>
							<Button onClick={() => void onSave()} disabled={saving || !draft}>
								{saving ? 'Saving…' : 'Save Listing'}
							</Button>
							<span style={styles.actionNote}>Saved with the draft — mode, pricing, screenshots all round-trip.</span>
						</div>
					)}
				</Card>

				{/* ── Right: pre-flight + review history ─────────────────── */}
				<div style={styles.rightCol}>
					<Card header="Pre-flight & submission">
						{checks.length === 0 ? (
							<EmptyState
								title="No pre-flight results"
								description="Build the app once, then the bundle, contract, listing, and Stripe checks run here."
							/>
						) : (
							<>
								{checks.map((c, i) => (
									<div key={c.id} style={i === 0 ? { ...styles.checkRow, ...styles.checkRowFirst } : styles.checkRow}>
										<div style={{ ...styles.checkMark, background: CHECK_PALETTE[c.state].bg, color: CHECK_PALETTE[c.state].fg }}>
											{CHECK_PALETTE[c.state].glyph}
										</div>
										<div style={styles.checkText}>{c.label}</div>
										{c.note ? <div style={styles.checkNote}>{c.note}</div> : null}
									</div>
								))}
								{host.submitForReview && (
									<div style={styles.actions}>
										<Button onClick={() => void onSubmit()} disabled={submitting || !canSubmit}>
											{submitting ? 'Submitting…' : `Submit ${app.version ? `v${app.version} ` : ''}for Review`}
										</Button>
										<span style={styles.actionNote}>every public version is reviewed; a push event delivers the decision.</span>
									</div>
								)}
							</>
						)}
					</Card>

					<Card header="Review history">
						{history.length === 0 ? (
							<EmptyState
								title="No reviews yet"
								description="Submissions, approvals, and rejections land here per version, with reviewer notes."
							/>
						) : (
							<div style={styles.timeline}>
								<div style={styles.timelineRail} />
								{history.map((item, i) => (
									<div key={`${item.when}-${i}`} style={styles.tlItem}>
										<div style={{ ...styles.tlDot, background: TL_DOT_COLOR[item.state] }} />
										<div style={styles.tlWhen}>{item.when}</div>
										<div style={styles.tlWhat}>{item.title}</div>
										{item.note ? <div style={styles.tlNote}>{item.note}</div> : null}
										{item.rejectionNotes ? <div style={styles.rejectQuote}>{item.rejectionNotes}</div> : null}
									</div>
								))}
							</div>
						)}
					</Card>
				</div>
			</div>
		</div>
	);
};
