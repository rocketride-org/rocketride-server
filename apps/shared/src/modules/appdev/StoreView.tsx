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
 * PROPOSAL that goes live on approval) and the store requirements checklist.
 * Personal, team, and org deploys never touch this tab; every version
 * deployed to the public rung is reviewed. Submission itself lives on the
 * DEPLOY tab — once every requirement passes, this view says "Ready to
 * deploy" and hands the user there instead of submitting in place.
 *
 * Pure view logic over the host adapter: hosts that have not wired the
 * marketplace loaders yet get teaching empty states.
 *
 * The whole view is ONE form (the record-panel footer pattern): edits stage
 * into a draft — including plan edits made through the PlanPanel drawer —
 * and an anchored Save/Cancel bar materializes at the bottom only while the
 * draft diverges from the saved manifest. Cancel routes through the stock
 * discard confirm before reverting to the baseline.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Banner } from 'shell';
import { Button } from 'shell';
import { Card } from 'shell';
import { ConfirmDialog } from 'shell';
import { EmptyState } from 'shell';
import { StatusBadge } from 'shell';
import { commonStyles } from 'shell';
import { PlanPanel } from './PlanPanel';
import type { AppBuilderStage, AppSummary, BillingPlan, IAppBuilderHost, ListingDraft, PreflightCheck } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link StoreView} component. */
export interface IStoreViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
	/** Render everything non-interactive (namespace mismatch gating). */
	readOnly?: boolean;
	/** Switch the builder to another stage — the "Ready to deploy" handoff. */
	onNavigate?: (stage: AppBuilderStage) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	// The view is one flex column: a scrolling content region above an
	// anchored footer bar — the footer never scrolls out of reach.
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	scroll: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
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
	form2col: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: 10,
	},
	// Pricing list — interval group headers with stock list rows underneath.
	planGroup: {
		...commonStyles.labelUppercase,
		color: 'var(--rr-text-secondary)',
		marginTop: 10,
		marginBottom: 2,
	},
	planRow: {
		...commonStyles.listRow(false),
		padding: '3px 8px 3px 16px',
	},
	planRowStatic: {
		cursor: 'default',
	},
	planName: {
		...commonStyles.textEllipsis,
		flex: 1,
	},
	planPrice: {
		...commonStyles.fontMono,
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	},
	planActions: {
		marginTop: 10,
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
	// ── Anchored form footer (DetailPanel's footer grammar, view gutters) ──
	// Materializes only while the draft diverges from the saved manifest:
	// note left, verbs right, divided from the scrolling content above.
	footer: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 26px',
		borderTop: '1px solid var(--rr-border)',
	},
	footerNote: {
		marginRight: 'auto',
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
	},
	submitMsg: {
		marginTop: 10,
	},
	// Save-failure banner — sits above the grid, on the view's gutters.
	errorWrap: {
		margin: '14px 26px 0',
		maxWidth: 1060,
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


// =============================================================================
// PRICING PRESENTATION
// =============================================================================

/** Interval groups in display order; unknown intervals append after these. */
const PLAN_GROUPS: Array<{ key: string; label: string }> = [
	{ key: 'month', label: 'Monthly Plans' },
	{ key: 'year', label: 'Annual Plans' },
	{ key: 'one_time', label: 'One-time' },
];

/** The storefront price label — metadata.displayAmount wins; always USD. */
function priceLabel(plan: BillingPlan): string {
	const display = (plan.metadata as { displayAmount?: unknown } | undefined)?.displayAmount;
	if (typeof display === 'string' && display) return display;
	return (plan.amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Sort key inside a group — metadata.order first, unordered plans last. */
function planOrder(plan: BillingPlan): number {
	const order = (plan.metadata as { order?: unknown } | undefined)?.order;
	return typeof order === 'number' ? order : Number.MAX_SAFE_INTEGER;
}

// =============================================================================
// DIRTY COMPARE
// =============================================================================

/**
 * Canonical compare form of the fields THIS view edits, defaults applied —
 * mode and the pricing plans only; package-tab fields (name, description,
 * assets, include) never dirty the store form.
 *
 * @param d - The draft to canonicalize.
 * @returns A stable JSON string for equality comparison.
 */
function storeFields(d: ListingDraft): string {
	return JSON.stringify({
		mode: d.mode ?? 'free',
		plans: d.plans ?? [],
	});
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the STORE view: listing card + pre-flight/submission + review
 * history.
 *
 * @param props - See {@link IStoreViewProps}.
 */
export const StoreView: React.FC<IStoreViewProps> = ({ host, app, readOnly, onNavigate }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	const [draft, setDraft] = useState<ListingDraft | null>(null);
	// The saved manifest the draft was seeded from — the dirty compare's
	// baseline and Cancel's revert target (ProfilePanel's exact model).
	const [saved, setSaved] = useState<ListingDraft | null>(null);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	const [saving, setSaving] = useState(false);
	// Save-failure text — a silent catch leaves the footer dirty with no
	// reason on screen, so the user presses Save into the void.
	const [error, setError] = useState('');
	// Footer-Cancel discard confirm (the standard's guard before reverting).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	/** Initial load: listing draft + pre-flight results. Seeds BOTH the
	 *  draft and the dirty baseline from the saved manifest. */
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const [d, c] = await Promise.all([host.loadListing?.() ?? Promise.resolve(null), host.runPreflight?.() ?? Promise.resolve([])]);
			// Seed an empty draft from the app facts when no record exists yet
			const loaded = d ?? { appId: app.id, mode: 'free' as const, name: app.name, description: app.description ?? '', plans: [] };
			setDraft(loaded);
			setSaved(loaded);
			setChecks(c);
		} catch (e) {
			console.log('[appdev] store refresh failed:', e);
		}
	}, [host, app.id, app.name, app.description]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Persist the WHOLE form (mode + plans) through the host, then reload —
	 *  the refresh re-seeds the baseline (the footer dematerializes) and
	 *  reruns pre-flight so the plan-count check tracks the save. */
	const onSave = useCallback(async (): Promise<void> => {
		if (!draft || !host.saveListing || readOnly) return;
		setSaving(true);
		setError('');
		try {
			await host.saveListing(draft);
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [draft, host, readOnly, refresh]);

	/** Confirmed discard: revert the draft to the saved baseline. */
	const onDiscard = useCallback((): void => {
		setConfirmDiscard(false);
		if (!saved) return;
		setDraft(saved);
	}, [saved]);

	// ── Plan record panel — a row click opens the record; "Add plan" opens
	// the same panel empty (interaction standard). idx null = Create mode.
	const [planPanel, setPlanPanel] = useState<{ idx: number | null } | null>(null);

	/** Stage a new plan list into the draft — persisted (with the rest of
	 *  the form) by the footer Save, reverted by the footer Cancel. Async
	 *  only to satisfy the PlanPanel's onSave/onRemove contract. */
	const stagePlans = useCallback(async (plans: BillingPlan[]): Promise<void> => {
		setDraft((d) => (d ? { ...d, plans } : d));
	}, []);

	// Marketplace not wired at all: one teaching empty state, no dead forms
	if (!host.loadListing && !host.runPreflight && !host.submitForReview) {
		return (
			<div style={styles.wrap}>
				<div style={styles.scroll}>
					<div style={styles.head}>
						<div style={styles.h1}>{app.name}</div>
						<div style={styles.sub}>Store — the commerce posture and the public rung: pricing mode, plans, and the requirements every public version must pass. Only needed to distribute on the App Store; @me and @team deploys skip all of this.</div>
					</div>
					<div style={styles.emptyWrap}>
						<EmptyState title="Store publishing is not wired up yet" description="Once the marketplace flows land, the listing form, pre-flight checks, and the per-version review timeline appear here." />
					</div>
				</div>
			</div>
		);
	}

	// Readiness gates on EVERY tier (the server would refuse a broken package
	// too); the card renders only the store-tier rows.
	const ready = checks.length > 0 && !checks.some((c) => c.state === 'fail');
	const storeChecks = checks.filter((c) => c.tier === 'store');
	const packageFails = checks.filter((c) => (c.tier ?? 'package') === 'package' && c.state === 'fail').length;

	// Dirty flag: mode or plans differ from the saved baseline. Drives the
	// materializing footer bar and gates the discard confirm.
	const dirty = draft !== null && saved !== null && storeFields(draft) !== storeFields(saved);

	return (
		<div style={styles.wrap}>
			{/* Scrolling content region — every card lives here; only the
			    footer bar below stays anchored. */}
			<div style={styles.scroll}>
				{/* View header — title + one-line purpose */}
				<div style={styles.head}>
					<div style={styles.h1}>{app.name}</div>
					<div style={styles.sub}>Store — the commerce posture and the public rung: pricing mode, plans, and the requirements every public version must pass. Only needed to distribute on the App Store; @me and @team deploys skip all of this. Every public version is reviewed — submission happens on the Deploy tab.</div>
				</div>

				{/* Save failure — the footer stays dirty, so the reason has to
				    be on screen or the retry looks like a no-op. */}
				{error ? (
					<div style={styles.errorWrap}>
						<Banner variant="error">{error}</Banner>
					</div>
				) : null}

				<div style={styles.grid}>
					{/* ── Left: the listing card ─────────────────────────────── */}
					<Card header="Store listing" headerActions={<StatusBadge variant={app.status === 'live' ? 'info' : 'muted'}>{app.status}</StatusBadge>}>
						<div style={styles.form2col}>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>App ID</div>
								<div style={styles.formStatic}>{draft?.appId ?? app.id}</div>
							</div>
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Mode</div>
								<select style={styles.formSelect} value={draft?.mode ?? 'free'} disabled={readOnly} onChange={(e) => setDraft((d) => (d ? { ...d, mode: e.target.value as ListingDraft['mode'] } : d))}>
									<option value="free">Free</option>
									<option value="subscription">Subscription</option>
									<option value="paywall">Paywall</option>
								</select>
							</div>
						</div>
						{/* Identity (name/description/icon/readme) lives on the
						    PACKAGE tab — this card is the commerce posture only. */}
						{(draft?.mode ?? 'free') !== 'free' && (
							<div style={styles.formRow}>
								<div style={styles.formLabel}>Pricing (proposal — live on approval)</div>
								{(() => {
									// Bucket plans by interval, keeping their draft index
									// for the record panel; unknown intervals get their
									// own trailing group rather than mislabeling.
									const plans = draft?.plans ?? [];
									const groups = [...PLAN_GROUPS];
									for (const p of plans) {
										if (!groups.some((g) => g.key === p.interval)) groups.push({ key: p.interval, label: p.interval });
									}
									return groups.map(({ key, label }) => {
										const rows = plans
											.map((plan, idx) => ({ plan, idx }))
											.filter(({ plan }) => plan.interval === key)
											.sort((a, b) => planOrder(a.plan) - planOrder(b.plan) || a.plan.nickname.localeCompare(b.plan.nickname));
										if (rows.length === 0) return null;
										return (
											<div key={key}>
												<div style={styles.planGroup}>{label}</div>
												{rows.map(({ plan, idx }) => (
													<div key={idx} style={readOnly ? { ...styles.planRow, ...styles.planRowStatic } : styles.planRow} onClick={readOnly ? undefined : () => setPlanPanel({ idx })}>
														<span style={styles.planName}>{plan.nickname}</span>
														<span style={styles.planPrice}>{priceLabel(plan)}</span>
													</div>
												))}
											</div>
										);
									});
								})()}
								{!readOnly && (
									<div style={styles.planActions}>
										<Button variant="secondary" small onClick={() => setPlanPanel({ idx: null })}>
											Add plan
										</Button>
									</div>
								)}
							</div>
						)}
					</Card>

					{/* ── Right: store requirements + the deploy handoff ─────── */}
					<div style={styles.rightCol}>
						<Card header="Store requirements">
							{checks.length === 0 ? (
								<EmptyState title="No checks yet" description="The store requirements run against the app's manifest once it loads." />
							) : (
								<>
									{/* Store-tier rows only — the complete-app bar lives on
									    the PACKAGE tab; a failure there still gates readiness
									    and is called out below by name. */}
									{storeChecks.map((c, i) => (
										<div key={c.id} style={i === 0 ? { ...styles.checkRow, ...styles.checkRowFirst } : styles.checkRow}>
											<div style={{ ...styles.checkMark, background: CHECK_PALETTE[c.state].bg, color: CHECK_PALETTE[c.state].fg }}>{CHECK_PALETTE[c.state].glyph}</div>
											<div style={styles.checkText}>{c.label}</div>
											{c.note ? <div style={styles.checkNote}>{c.note}</div> : null}
										</div>
									))}
									{/* The handoff, not the action: submission itself lives
									    on the DEPLOY tab. Green board = say so and take the
									    user there; a package failure names the tab to fix. */}
									{!readOnly &&
										(ready ? (
											<div style={styles.actions}>
												{onNavigate && (
													<Button onClick={() => onNavigate('deploy')}>Ready to deploy</Button>
												)}
												<span style={styles.actionNote}>everything the store requires is in place — deploy a version and submit it for review on the Deploy tab.</span>
											</div>
										) : packageFails > 0 ? (
											<div style={styles.submitMsg}>
												<Banner variant="warning">{`The Package tab has ${packageFails} failing item${packageFails === 1 ? '' : 's'} — fix ${packageFails === 1 ? 'it' : 'them'} there before deploying.`}</Banner>
											</div>
										) : null)}
								</>
							)}
						</Card>
					</div>
				</div>
			</div>

			{/* ── Anchored form footer (record-panel standard): materializes
			      only while the draft diverges from the saved manifest — Save
			      persists the WHOLE form (mode + plans), Cancel reverts via
			      the discard confirm. ───────────────────────────────────────── */}
			{dirty && host.saveListing && !readOnly && (
				<div style={styles.footer}>
					<span style={styles.footerNote}>Saved to the app&rsquo;s package.json — the manifest is the listing truth.</span>
					<Button variant="primary" small onClick={() => void onSave()} disabled={saving}>
						{saving ? 'Saving…' : 'Save Listing'}
					</Button>
					<Button variant="ghost" small onClick={() => setConfirmDiscard(true)} disabled={saving}>
						Cancel
					</Button>
				</div>
			)}

			{/* ── Plan record panel (stock DetailPanel, viewport drawer) ──────
			      Its Save STAGES into the form draft; the manifest write happens
			      through the footer's Save Listing. */}
			{planPanel && draft && <PlanPanel open plan={planPanel.idx === null ? null : (draft.plans[planPanel.idx] ?? null)} appName={draft.name || app.name} onSave={(p) => stagePlans(planPanel.idx === null ? [...draft.plans, p] : draft.plans.map((x, i) => (i === planPanel.idx ? p : x)))} onRemove={planPanel.idx === null ? undefined : () => stagePlans(draft.plans.filter((_, i) => i !== planPanel.idx))} onClose={() => setPlanPanel(null)} />}

			{/* ── Footer-Cancel discard guard — the stock confirm before the
			      draft reverts to the saved baseline. ───────────────────────── */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={onDiscard}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</div>
	);
};
