// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Breadcrumbs — where the current view sits in a hierarchy:
 * Org / Project / Pipeline / Run 42. Every crumb but the last navigates;
 * the last is the current page (`aria-current="page"`).
 *
 * Long trails collapse their middle into an "…" button once there are more
 * than `maxItems` crumbs; activating it reveals the hidden crumbs in place.
 * Crumbs navigate through `href` (real links) or `onClick` (in-app routing).
 *
 * Built on `.rr-breadcrumbs` from components.css.
 */

import React, { ReactNode, useEffect, useRef, useState } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** One crumb. */
export interface IBreadcrumb {
	/** Stable id. */
	id: string;
	/** Visible text. */
	label: ReactNode;
	/** Link target (renders an anchor). */
	href?: string;
	/** In-app navigation (renders a button when there is no href). */
	onClick?: () => void;
	/** Optional leading icon. */
	icon?: ReactNode;
}

/** Props for the {@link Breadcrumbs} component. */
export interface IBreadcrumbsProps {
	/** The trail, root first; the last item is the current page. */
	items: IBreadcrumb[];
	/** Collapse the middle beyond this many crumbs. Defaults to 4. */
	maxItems?: number;
	/** Accessible name of the nav landmark. Defaults to `'Breadcrumb'`. */
	ariaLabel?: string;
}

/** A visible entry: a crumb, or the collapsed-middle marker. */
export type BreadcrumbSlot = { kind: 'item'; item: IBreadcrumb } | { kind: 'collapsed'; hidden: IBreadcrumb[] };

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The visible slots for a trail: everything when it fits, otherwise the
 * first crumb, a collapsed marker, and the last `maxItems - 2` crumbs.
 *
 * @param items - The full trail.
 * @param maxItems - The most crumbs shown.
 * @returns Slots in display order.
 */
export function collapseBreadcrumbs(items: readonly IBreadcrumb[], maxItems: number): BreadcrumbSlot[] {
	if (items.length <= maxItems || maxItems < 3) {
		return items.map((item) => ({ kind: 'item', item }));
	}
	const tailCount = maxItems - 2;
	const first = items[0];
	const hidden = items.slice(1, items.length - tailCount);
	const tail = items.slice(items.length - tailCount);
	return [{ kind: 'item', item: first }, { kind: 'collapsed', hidden }, ...tail.map((item): BreadcrumbSlot => ({ kind: 'item', item }))];
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a breadcrumb trail.
 *
 * @param props - {@link IBreadcrumbsProps}.
 * @returns The breadcrumb nav landmark.
 */
export function Breadcrumbs({ items, maxItems = 4, ariaLabel = 'Breadcrumb' }: IBreadcrumbsProps): React.ReactElement {
	const [isExpanded, setIsExpanded] = useState(false);
	const listRef = useRef<HTMLOListElement>(null);
	const isFocusPendingRef = useRef(false);

	// Expanding removes the "…" button that had focus; hand focus to the
	// first revealed crumb so keyboard users keep their place.
	useEffect(() => {
		if (!isExpanded || !isFocusPendingRef.current) return;
		isFocusPendingRef.current = false;
		const revealed = listRef.current?.children[1]?.querySelector<HTMLElement>('a, button, [aria-current]');
		revealed?.focus();
	}, [isExpanded]);

	let slots = collapseBreadcrumbs(items, maxItems);
	if (isExpanded) slots = collapseBreadcrumbs(items, Number.MAX_SAFE_INTEGER);
	const lastItem = items[items.length - 1];

	return (
		<nav className="rr-breadcrumbs" aria-label={ariaLabel}>
			<ol ref={listRef} className="rr-breadcrumbs__list">
				{slots.map((slot) => {
					if (slot.kind === 'collapsed') {
						return (
							<li key="collapsed" className="rr-breadcrumbs__item">
								<button
									type="button"
									className="rr-breadcrumbs__link"
									aria-label={`Show ${slot.hidden.length} more`}
									onClick={() => {
										isFocusPendingRef.current = true;
										setIsExpanded(true);
									}}
								>
									…
								</button>
							</li>
						);
					}

					const { item } = slot;
					const isCurrent = item === lastItem;
					let content: ReactNode = (
						<span className="rr-breadcrumbs__current" aria-current="page">
							{item.icon}
							{item.label}
						</span>
					);
					if (!isCurrent && item.href) {
						content = (
							<a className="rr-breadcrumbs__link" href={item.href} onClick={item.onClick}>
								{item.icon}
								{item.label}
							</a>
						);
					} else if (!isCurrent && item.onClick) {
						content = (
							<button type="button" className="rr-breadcrumbs__link" onClick={item.onClick}>
								{item.icon}
								{item.label}
							</button>
						);
					} else if (!isCurrent) {
						content = (
							<span className="rr-breadcrumbs__text">
								{item.icon}
								{item.label}
							</span>
						);
					}

					return (
						<li key={item.id} className="rr-breadcrumbs__item">
							{content}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
