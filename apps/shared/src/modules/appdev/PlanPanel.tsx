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
// PLAN PANEL — the pricing-plan record panel (stock DetailPanel)
// =============================================================================

/**
 * PlanPanel — the record panel for ONE `appManifest.billing.plans` entry.
 *
 * A stock DetailPanel opened by a plan-row click in the STORE view (or by
 * "Add plan" in Create mode), following the interaction standard: staged
 * fields, [Save plan]/[Cancel] materialize on the first change, footer-left
 * destructive [Remove plan] behind a ConfirmDialog, and the built-in dirty
 * discard guard on X/Escape.
 *
 * The panel edits the plan's full Stripe-shaped surface — price, interval,
 * kind, ordering, seats, credits (initial/recurring + unit label), display
 * override, features, and the listing description lines. Metadata keys it
 * does not edit (e.g. an Enterprise `action` block) ride the save verbatim.
 */

import React, { useCallback, useEffect, useState, CSSProperties } from 'react';
import { Banner } from 'shell';
import { Button } from 'shell';
import { ConfirmDialog } from 'shell';
import { DetailPanel } from 'shell';
import { InputField } from 'shell';
import { commonStyles } from 'shell';
import type { BillingPlan } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link PlanPanel}. */
export interface IPlanPanelProps {
	/** Whether the panel is open (DetailPanel renders nothing when closed). */
	open: boolean;
	/** The plan being edited, or null to create a new one. */
	plan: BillingPlan | null;
	/** App display name for the header subtitle. */
	appName: string;
	/** Persist the staged plan (create or update). Errors render in-panel. */
	onSave: (plan: BillingPlan) => Promise<void>;
	/** Remove this plan (existing records only; ConfirmDialog-guarded here). */
	onRemove?: () => Promise<void>;
	/** Dismiss without saving. */
	onClose: () => void;
}

/** The known metadata surface of a plan — unknown keys are preserved. */
interface PlanMetadata {
	order?: number;
	seats?: number;
	kind?: string;
	features?: string[];
	description?: string[];
	credits?: { initial?: Record<string, number>; recurring?: Record<string, number> };
	labels?: Record<string, string>;
	displayAmount?: string;
	[key: string]: unknown;
}

/** The staged form fields (all strings — parsed on save). */
interface StagedPlan {
	name: string;
	priceDollars: string;
	interval: string;
	kind: string;
	order: string;
	seats: string;
	creditsInitial: string;
	creditsRecurring: string;
	creditLabel: string;
	displayAmount: string;
	features: string;
	description: string;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	sectionLabel: {
		...commonStyles.labelUppercase,
		padding: '14px 0 4px',
	} as CSSProperties,
	fieldGrid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '10px 12px',
	} as CSSProperties,
	fieldFull: {
		gridColumn: '1 / -1',
	} as CSSProperties,
	fieldLabel: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginBottom: 4,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.03em',
	} as CSSProperties,
	// Raw-input twin of the stock InputField look — the autofocus field must
	// be an intrinsic <input> to carry data-rr-autofocus (ApiKeysPanel pattern).
	input: {
		...commonStyles.inputField,
		height: 34,
		padding: '0 12px',
		borderRadius: 7,
		background: 'var(--rr-bg-default)',
		width: '100%',
	} as CSSProperties,
	select: {
		...commonStyles.inputField,
		height: 34,
		padding: '0 8px',
		borderRadius: 7,
		background: 'var(--rr-bg-default)',
		width: '100%',
	} as CSSProperties,
	textarea: {
		...commonStyles.inputField,
		padding: '8px 12px',
		borderRadius: 7,
		background: 'var(--rr-bg-default)',
		width: '100%',
		minHeight: 72,
		lineHeight: 1.5,
		resize: 'vertical' as const,
		fontFamily: 'inherit',
	} as CSSProperties,
	fieldHint: {
		...commonStyles.textMuted,
		fontSize: 11,
		marginTop: 3,
	} as CSSProperties,
	footerLeft: {
		marginRight: 'auto',
		display: 'flex',
		gap: 8,
	} as CSSProperties,
};

// =============================================================================
// STAGING — plan <-> form field mapping
// =============================================================================

/** The credits unit key the platform bills in (labels.tokens names it). */
const CREDIT_UNIT = 'tokens';

/**
 * Seeds the staged form fields from a plan (or Create-mode defaults).
 *
 * @param plan - The plan being edited, or null for a new one.
 * @returns The staged field values.
 */
function stageOf(plan: BillingPlan | null): StagedPlan {
	const meta = (plan?.metadata ?? {}) as PlanMetadata;
	return {
		name: plan?.nickname ?? '',
		priceDollars: plan ? String(plan.amountCents / 100) : '',
		interval: plan?.interval ?? 'month',
		kind: typeof meta.kind === 'string' ? meta.kind : '',
		order: meta.order !== undefined ? String(meta.order) : '',
		seats: meta.seats !== undefined ? String(meta.seats) : '',
		creditsInitial: meta.credits?.initial?.[CREDIT_UNIT] !== undefined ? String(meta.credits.initial[CREDIT_UNIT]) : '',
		creditsRecurring: meta.credits?.recurring?.[CREDIT_UNIT] !== undefined ? String(meta.credits.recurring[CREDIT_UNIT]) : '',
		creditLabel: meta.labels?.[CREDIT_UNIT] ?? '',
		displayAmount: meta.displayAmount ?? '',
		features: Array.isArray(meta.features) ? meta.features.join(', ') : '',
		description: Array.isArray(meta.description) ? meta.description.join('\n') : '',
	};
}

/** Parses a staged numeric field ('' = absent). */
function numOf(value: string): number | undefined {
	const n = Number(value);
	return value.trim() === '' || Number.isNaN(n) ? undefined : n;
}

/**
 * Builds the plan to persist from the staged fields, preserving every
 * metadata key the form does not edit.
 *
 * @param staged - The staged field values.
 * @param original - The plan being edited (metadata carry-over), or null.
 * @returns The plan row for `billing.plans`.
 */
function planOf(staged: StagedPlan, original: BillingPlan | null): BillingPlan {
	// Carry the original metadata verbatim, then set/delete the edited keys
	const meta: PlanMetadata = { ...((original?.metadata ?? {}) as PlanMetadata) };

	const setOrDelete = (key: keyof PlanMetadata, value: unknown): void => {
		if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete meta[key];
		else meta[key] = value;
	};
	setOrDelete('order', numOf(staged.order));
	setOrDelete('seats', numOf(staged.seats));
	setOrDelete('kind', staged.kind || undefined);
	setOrDelete('displayAmount', staged.displayAmount.trim() || undefined);
	setOrDelete('features', staged.features.split(',').map((f) => f.trim()).filter(Boolean));
	setOrDelete('description', staged.description.split('\n').map((l) => l.trim()).filter(Boolean));

	// Credits: set/delete the unit key inside initial/recurring, dropping
	// emptied objects so a credit-less plan carries no credits block
	const credits = { ...(meta.credits ?? {}) };
	for (const [slot, value] of [['initial', numOf(staged.creditsInitial)], ['recurring', numOf(staged.creditsRecurring)]] as const) {
		const bag = { ...(credits[slot] ?? {}) };
		if (value === undefined) delete bag[CREDIT_UNIT];
		else bag[CREDIT_UNIT] = value;
		if (Object.keys(bag).length === 0) delete credits[slot];
		else credits[slot] = bag;
	}
	setOrDelete('credits', Object.keys(credits).length ? credits : undefined);

	// The unit's display label rides labels.tokens
	const labels = { ...(meta.labels ?? {}) };
	if (staged.creditLabel.trim()) labels[CREDIT_UNIT] = staged.creditLabel.trim();
	else delete labels[CREDIT_UNIT];
	setOrDelete('labels', Object.keys(labels).length ? labels : undefined);

	return {
		nickname: staged.name.trim(),
		amountCents: Math.max(0, Math.round((numOf(staged.priceDollars) ?? 0) * 100)),
		currency: original?.currency ?? 'usd',
		interval: staged.interval,
		...(Object.keys(meta).length ? { metadata: meta as Record<string, unknown> } : {}),
	};
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the pricing-plan record panel.
 *
 * @param props - See {@link IPlanPanelProps}.
 */
export const PlanPanel: React.FC<IPlanPanelProps> = ({ open, plan, appName, onSave, onRemove, onClose }) => {
	// ── Staged fields — seeded per open (never re-seeded mid-edit) ────────
	const [staged, setStaged] = useState<StagedPlan>(() => stageOf(plan));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [discardConfirm, setDiscardConfirm] = useState(false);
	const [removeConfirm, setRemoveConfirm] = useState(false);

	useEffect(() => {
		if (open) {
			setStaged(stageOf(plan));
			setError('');
		}
		// Re-seed only when the panel (re)opens — the user's typing is sacred.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	/** Patch one staged field. */
	const patch = useCallback(<K extends keyof StagedPlan>(key: K, value: StagedPlan[K]): void => {
		setStaged((s) => ({ ...s, [key]: value }));
	}, []);

	// Save's presence IS the dirty indicator (interaction standard)
	const dirty = JSON.stringify(staged) !== JSON.stringify(stageOf(plan));

	/** Persist the staged plan; a failed save stays open with the error. */
	const save = async (): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await onSave(planOf(staged, plan));
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** Remove the record (already confirmed); the panel closes after. */
	const remove = async (): Promise<void> => {
		if (!onRemove) return;
		setBusy(true);
		setError('');
		try {
			await onRemove();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** One labelled field cell. The label is a plain `<div>`, so the control
	 * carries no accessible name on its own — push the label text down as an
	 * `aria-label` so a screen reader announces each input/select by its label. */
	const field = (label: string, node: React.ReactNode, full = false, hint?: string): React.ReactNode => (
		<div style={full ? S.fieldFull : undefined}>
			<div style={S.fieldLabel}>{label}</div>
			{React.isValidElement(node) ? React.cloneElement(node as React.ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label }) : node}
			{hint ? <div style={S.fieldHint}>{hint}</div> : null}
		</div>
	);

	return (
		<>
			<DetailPanel
				open={open}
				onClose={onClose}
				title={plan ? `Plan — ${plan.nickname}` : 'New plan'}
				subtitle={`${appName} pricing — staged into the manifest; live on store approval.`}
				busy={busy}
				dirty={dirty}
				editing
				onExitMode={onClose}
				footer={
					<>
						<span style={S.footerLeft}>
							{plan && onRemove && (
								<Button variant="danger" small disabled={busy} onClick={() => setRemoveConfirm(true)}>
									Remove plan
								</Button>
							)}
						</span>
						{dirty && (
							<>
								<Button variant="primary" small disabled={busy || !staged.name.trim()} onClick={() => void save()}>
									{busy ? 'Saving…' : plan ? 'Save plan' : 'Create plan'}
								</Button>
								<Button variant="ghost" small disabled={busy} onClick={() => setDiscardConfirm(true)}>
									Cancel
								</Button>
							</>
						)}
					</>
				}
			>
				<div>
					{error ? <Banner variant="error">{error}</Banner> : null}

					{/* ── PLAN — identity ──────────────────────────────────── */}
					<div style={S.sectionLabel}>Plan</div>
					<div style={S.fieldGrid}>
						{field('Plan name', <input style={S.input} value={staged.name} disabled={busy} data-rr-autofocus="true" onChange={(e) => patch('name', e.target.value)} />)}
						{field('Kind', (
							<select style={S.select} value={staged.kind} disabled={busy} onChange={(e) => patch('kind', e.target.value)}>
								<option value="">Standard plan</option>
								<option value="topup">Top-up (credit pack)</option>
								<option value="promo_base">Promo base</option>
							</select>
						))}
					</div>

					{/* ── PRICE ────────────────────────────────────────────── */}
					<div style={S.sectionLabel}>Price</div>
					<div style={S.fieldGrid}>
						{field('Price (USD)', <InputField type="number" min={0} step={0.01} value={staged.priceDollars} disabled={busy} onChange={(e) => patch('priceDollars', e.target.value)} />)}
						{field('Interval', (
							<select style={S.select} value={staged.interval} disabled={busy} onChange={(e) => patch('interval', e.target.value)}>
								<option value="month">Monthly</option>
								<option value="year">Annual</option>
								<option value="one_time">One-time</option>
							</select>
						))}
						{field('Displayed amount', <InputField value={staged.displayAmount} disabled={busy} placeholder="e.g. Custom" onChange={(e) => patch('displayAmount', e.target.value)} />, true,
							'Optional override shown instead of the price (Enterprise "Custom").')}
					</div>

					{/* ── CREDITS ──────────────────────────────────────────── */}
					<div style={S.sectionLabel}>Credits</div>
					<div style={S.fieldGrid}>
						{field('Welcome credits', <InputField type="number" min={0} value={staged.creditsInitial} disabled={busy} onChange={(e) => patch('creditsInitial', e.target.value)} />, false,
							'Granted once on purchase.')}
						{field('Recurring credits', <InputField type="number" min={0} value={staged.creditsRecurring} disabled={busy} onChange={(e) => patch('creditsRecurring', e.target.value)} />, false,
							'Granted every interval.')}
						{field('Credit label', <InputField value={staged.creditLabel} disabled={busy} placeholder="tokens" onChange={(e) => patch('creditLabel', e.target.value)} />, true,
							'What the credits are called in the storefront.')}
					</div>

					{/* ── POSITIONING ──────────────────────────────────────── */}
					<div style={S.sectionLabel}>Positioning</div>
					<div style={S.fieldGrid}>
						{field('Sort order', <InputField type="number" value={staged.order} disabled={busy} onChange={(e) => patch('order', e.target.value)} />, false,
							'Lower numbers list first.')}
						{field('Seats', <InputField type="number" min={1} value={staged.seats} disabled={busy} onChange={(e) => patch('seats', e.target.value)} />)}
					</div>

					{/* ── LISTING COPY ─────────────────────────────────────── */}
					<div style={S.sectionLabel}>Listing copy</div>
					<div style={S.fieldGrid}>
						{field('Features', <InputField value={staged.features} disabled={busy} placeholder="pipelines, priority_support" onChange={(e) => patch('features', e.target.value)} />, true,
							'Comma-separated feature flags.')}
						{field('Description lines', (
							<textarea
								style={S.textarea}
								value={staged.description}
								disabled={busy}
								placeholder={'500 tokens/month included\n$0.03/token overage'}
								onChange={(e) => patch('description', e.target.value)}
							/>
						), true, 'One storefront bullet per line.')}
					</div>
				</div>
			</DetailPanel>

			{/* ── Discard guard for the footer Cancel (stock ConfirmDialog) ── */}
			{discardConfirm && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						setDiscardConfirm(false);
						onClose();
					}}
					onCancel={() => setDiscardConfirm(false)}
				/>
			)}

			{/* ── Remove confirmation (destructive record verb) ────────────── */}
			{removeConfirm && (
				<ConfirmDialog
					title={`Remove ${plan?.nickname || 'this plan'}?`}
					message="The plan is removed from the manifest's pricing proposal. Already-purchased subscriptions are not affected."
					confirmLabel="Remove"
					cancelLabel="Cancel"
					destructive
					onConfirm={() => {
						setRemoveConfirm(false);
						void remove();
					}}
					onCancel={() => setRemoveConfirm(false)}
				/>
			)}
		</>
	);
};
