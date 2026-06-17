// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PlanPicker -- shared plan card grid with interval toggle.
 *
 * Renders subscription plans as side-by-side cards grouped by billing
 * interval (Monthly / Annual).  Plans with a ``metadata.action`` field
 * render as non-selectable cards with a CTA link/button instead of a
 * radio selection.  Plans with ``interval === 'one_time'`` or no interval
 * are always visible regardless of the toggle.
 *
 * Top-up packs (``metadata.kind === 'topup'``) are excluded -- they are
 * shown on the billing dashboard instead.
 *
 * Used by:
 *   - **CheckoutModal** -- passes ``selectedPlan`` / ``onSelectPlan``
 *     and a "Continue" button via the ``footer`` slot.
 *   - **PricingPage** -- display-only, no selection or footer needed.
 */

import React, { useState, useMemo, useCallback, useEffect, type CSSProperties } from 'react';
import type { CheckoutPlan, PlanAction } from './types';

// =============================================================================
// HELPERS
// =============================================================================

/** Extract the action descriptor from plan metadata, if present. */
function planAction(plan: CheckoutPlan): PlanAction | null {
	return (plan.metadata?.action as PlanAction) ?? null;
}

/** Extract the sort order from plan metadata, defaulting to 500. */
function planOrder(plan: CheckoutPlan): number {
	try { const n = parseInt(plan.metadata?.order, 10); return Number.isFinite(n) ? n : 500; } catch { return 500; }
}

/** Extract description lines from plan metadata. */
function planDescription(plan: CheckoutPlan): string[] | null {
	const d = plan.metadata?.description;
	if (Array.isArray(d)) return d;
	return null;
}

/** Format amountCents as a display price string, respecting metadata.displayAmount override. */
export function planAmount(plan: CheckoutPlan): string {
	const display = plan.metadata?.displayAmount;
	if (display) return display;
	const amount = (plan.amountCents || 0) / 100;
	const symbol = (plan as any).currency?.toUpperCase() === 'EUR' ? '\u20AC' : '$';
	return amount === Math.floor(amount) ? `${symbol}${amount}` : `${symbol}${amount.toFixed(2)}`;
}

/**
 * Builds the href for a plan action (link URL or mailto: URI).
 *
 * @param action - The plan action descriptor.
 * @returns A navigable URL string.
 */
function actionHref(action: PlanAction): string {
	if (action.type === 'mailto') {
		const subject = action.subject ? `?subject=${encodeURIComponent(action.subject)}` : '';
		return `mailto:${action.url}${subject}`;
	}
	return action.url;
}

/**
 * Default handler for action plan clicks -- opens link in new tab or mailto.
 *
 * @param _plan  - The plan that was clicked (unused, kept for signature).
 * @param action - The action descriptor with type and url.
 */
function defaultActionClick(_plan: CheckoutPlan, action: PlanAction): void {
	const href = actionHref(action);
	if (action.type === 'link') {
		window.open(href, '_blank', 'noopener,noreferrer');
	} else {
		window.location.href = href;
	}
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// ── Interval toggle ──────────────────────────────────────────────────
	toggleRow: {
		display: 'flex',
		justifyContent: 'center',
		marginBottom: 20,
	} as CSSProperties,

	toggleBar: {
		display: 'inline-flex',
		background: 'var(--rr-bg-titleBar-inactive)',
		borderRadius: 8,
		padding: 3,
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	toggleBtn: (active: boolean): CSSProperties => ({
		padding: '6px 22px',
		borderRadius: 6,
		border: 'none',
		fontSize: 13,
		fontWeight: 600,
		cursor: 'pointer',
		background: active ? 'var(--rr-brand)' : 'transparent',
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
		transition: 'background 0.15s, color 0.15s',
	}),

	// ── Plan card grid ───────────────────────────────────────────────────
	planGrid: (count: number): CSSProperties => ({
		display: 'grid',
		gridTemplateColumns: count <= 2
			? `repeat(${count}, 1fr)`
			: `repeat(auto-fit, minmax(150px, 1fr))`,
		gap: 10,
		marginBottom: 16,
	}),

	planCard: (selected: boolean): CSSProperties => ({
		display: 'flex',
		flexDirection: 'column',
		borderRadius: 10,
		border: `2px solid ${selected ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		background: 'var(--rr-bg-paper)',
		cursor: 'pointer',
		transition: 'border-color 0.15s, box-shadow 0.15s',
		boxShadow: selected ? '0 0 0 1px var(--rr-brand)' : 'none',
		overflow: 'hidden',
	}),

	cardHead: (selected: boolean): CSSProperties => ({
		padding: '12px 12px 10px',
		background: selected ? 'var(--rr-bg-list-active)' : 'var(--rr-bg-titleBar-inactive)',
		textAlign: 'center',
	}),

	cardTier: {
		fontSize: 10,
		fontWeight: 700,
		letterSpacing: 1.2,
		textTransform: 'uppercase' as const,
		color: 'var(--rr-text-secondary)',
		margin: 0,
	} as CSSProperties,

	cardPrice: {
		fontSize: 22,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: '4px 0 0',
	} as CSSProperties,

	cardInterval: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 1,
	} as CSSProperties,

	cardFeatures: {
		flex: 1,
		padding: '8px 12px 12px',
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 3,
	} as CSSProperties,

	featureLine: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.4,
		display: 'flex',
		alignItems: 'baseline',
		gap: 6,
	} as CSSProperties,

	featureCheck: {
		color: 'var(--rr-color-success)',
		fontSize: 11,
		fontWeight: 700,
		flexShrink: 0,
	} as CSSProperties,

	// ── Action button inside a card (for link/mailto plans) ──────────────
	cardAction: {
		display: 'block',
		margin: '6px 12px 12px',
		padding: '6px 0',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 12,
		fontWeight: 600,
		textAlign: 'center' as const,
		textDecoration: 'none',
		cursor: 'pointer',
		transition: 'background 0.15s',
	} as CSSProperties,

	// ── Loading / empty state ────────────────────────────────────────────
	status: {
		textAlign: 'center' as const,
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		padding: '32px 0',
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for the PlanPicker component.
 */
export interface PlanPickerProps {
	/** Plans to display. Plans with ``metadata.action`` render as non-selectable CTA cards. */
	plans: CheckoutPlan[];

	/** True while plans are loading -- shows a placeholder. */
	loading?: boolean;

	/** Currently selected checkout-able plan (controlled). */
	selectedPlan?: CheckoutPlan | null;

	/** Called when the user selects a billable plan. Not called for action plans. */
	onSelectPlan?: (plan: CheckoutPlan) => void;

	/** Called when the user clicks an action plan's CTA. Defaults to opening the link/mailto natively. */
	onActionClick?: (plan: CheckoutPlan, action: PlanAction) => void;

	/** Content rendered below the plan cards (e.g. a "Continue" button). */
	footer?: React.ReactNode;

	/** Default interval on first render. Default: ``'month'``. */
	defaultInterval?: 'month' | 'year';

	/**
	 * When true, ensures a billable plan is always selected: on mount (and
	 * whenever the visible plans change) the lowest-order billable plan at the
	 * current interval is selected if the current selection is absent or not
	 * visible. Requires ``onSelectPlan``. Default: ``false`` (caller-controlled
	 * selection, e.g. the upgrade/top-up modals).
	 */
	autoSelectDefault?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Shared plan card grid with interval toggle.
 *
 * Renders plans as side-by-side cards. Manages the Monthly/Annual toggle
 * internally. Action plans (Free, Enterprise) always show; billable plans
 * are filtered by the selected interval.
 */
export const PlanPicker: React.FC<PlanPickerProps> = ({
	plans,
	loading = false,
	selectedPlan = null,
	onSelectPlan,
	onActionClick = defaultActionClick,
	footer,
	defaultInterval = 'month',
	autoSelectDefault = false,
}) => {
	// ── Internal interval state ──────────────────────────────────────────
	const [interval, setInterval] = useState<'month' | 'year'>(defaultInterval);

	// Reset interval when plans change (e.g. different app loaded)
	useEffect(() => {
		const hasMonth = plans.some((p) => p.interval === 'month');
		const hasYear = plans.some((p) => p.interval === 'year');
		if (!hasMonth && hasYear) {
			setInterval('year');
		} else if (hasMonth) {
			setInterval('month');
		}
	}, [plans]);

	// ── Derived data ─────────────────────────────────────────────────────

	// Show toggle only when a non-action nickname appears at BOTH month and year.
	const showToggle = useMemo(() => {
		const byNickname = new Map<string, Set<string>>();
		for (const p of plans) {
			if (planAction(p)) continue;
			if (p.interval !== 'month' && p.interval !== 'year') continue;
			const set = byNickname.get(p.nickname) ?? new Set();
			set.add(p.interval);
			byNickname.set(p.nickname, set);
		}
		for (const intervals of byNickname.values()) {
			if (intervals.size > 1) return true;
		}
		return false;
	}, [plans]);

	// Plans visible at the current interval, sorted by order ascending.
	const visiblePlans = useMemo(() => {
		const filtered = showToggle
			? plans.filter((p) => !p.interval || p.interval === 'one_time' || p.interval === interval)
			: plans;
		return [...filtered].sort((a, b) => planOrder(a) - planOrder(b));
	}, [plans, interval, showToggle]);

	// The lowest-order billable plan visible at the current interval -- the
	// "Starter" default. ``visiblePlans`` is already sorted by order ascending.
	const defaultPlan = useMemo(
		() => visiblePlans.find((p) => !planAction(p)) ?? null,
		[visiblePlans]
	);

	// ── Default selection ─────────────────────────────────────────────────

	// When ``autoSelectDefault`` is set, guarantee a billable plan is selected
	// and that it is visible at the current interval. Covers initial mount and
	// any case where the previous selection is no longer shown (e.g. after an
	// interval toggle that has no matching tier). Keeps the selection visually
	// indicated so the user is never charged for an unshown plan.
	useEffect(() => {
		if (!autoSelectDefault || !onSelectPlan) return;
		const stillVisible =
			selectedPlan && visiblePlans.some((p) => p.stripePriceId === selectedPlan.stripePriceId && !planAction(p));
		if (!stillVisible && defaultPlan) {
			onSelectPlan(defaultPlan);
		}
	}, [autoSelectDefault, onSelectPlan, selectedPlan, visiblePlans, defaultPlan]);

	// ── Handlers ─────────────────────────────────────────────────────────

	/** Switch interval and try to keep the same tier selected. */
	const handleToggle = useCallback(
		(newInterval: 'month' | 'year') => {
			setInterval(newInterval);

			if (!onSelectPlan) return;

			// Persist the last selection across the toggle: keep the same tier
			// (match by nickname) at the new interval when it exists.
			if (selectedPlan && !planAction(selectedPlan)) {
				const sameTier = plans.find(
					(p) => p.nickname === selectedPlan.nickname && p.interval === newInterval && !planAction(p)
				);
				if (sameTier) {
					onSelectPlan(sameTier);
					return;
				}
			}

			// Otherwise, when this picker owns the default selection, fall back to
			// the lowest-order (Starter) billable plan at the new interval. For
			// caller-controlled pickers (no auto-default) leave the selection
			// untouched so an intentional "nothing selected" state is preserved.
			if (!autoSelectDefault) return;
			const fallback = plans
				.filter((p) => p.interval === newInterval && !planAction(p))
				.sort((a, b) => planOrder(a) - planOrder(b))[0];
			if (fallback) onSelectPlan(fallback);
		},
		[plans, selectedPlan, onSelectPlan, autoSelectDefault]
	);

	// ── Render ───────────────────────────────────────────────────────────

	// Loading state
	if (loading) {
		return <p style={S.status}>Loading plans&hellip;</p>;
	}

	// Empty state
	if (plans.length === 0) {
		return <p style={S.status}>No plans available.</p>;
	}

	return (
		<div>
			{/* Interval toggle */}
			{showToggle && (
				<div style={S.toggleRow}>
					<div style={S.toggleBar}>
						<button style={S.toggleBtn(interval === 'month')} onClick={() => handleToggle('month')}>
							Monthly
						</button>
						<button style={S.toggleBtn(interval === 'year')} onClick={() => handleToggle('year')}>
							Annual
						</button>
					</div>
				</div>
			)}

			{/* Plan cards grid */}
			<div style={S.planGrid(visiblePlans.length)} role="radiogroup" aria-label="Subscription plans">
				{visiblePlans.map((plan) => {
					const action = planAction(plan);
					const isAction = !!action;
					const selected = !isAction && selectedPlan?.stripePriceId === plan.stripePriceId;
					const desc = planDescription(plan);

					return (
						<div
							key={plan.stripePriceId || plan.id}
							style={S.planCard(selected)}
							onClick={() => {
								if (!isAction && onSelectPlan) onSelectPlan(plan);
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									if (!isAction && onSelectPlan) onSelectPlan(plan);
								}
							}}
							role={isAction ? undefined : 'radio'}
							tabIndex={0}
							aria-checked={isAction ? undefined : selected}
						>
							{/* Card header: tier name, price, interval */}
							<div style={S.cardHead(selected)}>
								<div style={S.cardTier}>{plan.nickname}</div>
								<div style={S.cardPrice}>{planAmount(plan)}</div>
								{plan.interval && plan.interval !== 'one_time' && (
									<div style={S.cardInterval}>
										per {plan.interval === 'month' ? 'month' : 'year'}
									</div>
								)}
							</div>

							{/* Feature description lines */}
							{desc && desc.length > 0 && (
								<div style={S.cardFeatures}>
									{desc.map((line, i) => (
										<div key={i} style={S.featureLine}>
											<span style={S.featureCheck}>&#10003;</span>
											<span>{line}</span>
										</div>
									))}
								</div>
							)}

							{/* Action button for link/mailto plans */}
							{action && (
								<a
									href={actionHref(action)}
									target={action.type === 'link' ? '_blank' : undefined}
									rel={action.type === 'link' ? 'noopener noreferrer' : undefined}
									style={S.cardAction}
									onClick={(e) => {
										e.stopPropagation();
										e.preventDefault();
										onActionClick(plan, action);
									}}
								>
									{action.label}
								</a>
							)}
						</div>
					);
				})}
			</div>

			{/* Footer slot (e.g. "Continue" button) */}
			{footer}
		</div>
	);
};
