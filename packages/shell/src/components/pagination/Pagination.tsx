// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pagination — page controls for lists, card grids and tables that page
 * outside DataGrid (DataGrid keeps its own footer).
 *
 * Shows previous/next, the first and last pages, the current page with
 * `siblingCount` neighbours each side, and "…" for the gaps, so the control
 * keeps a stable width as you page. Optional page-size picker and a
 * "21–40 of 134" range when `totalItems` is known. The current page carries
 * `aria-current="page"`; the whole control is a labelled nav landmark.
 *
 * Built on `.rr-pagination` from components.css.
 */

import React from 'react';
import { Select } from '../form/Select';

// =============================================================================
// TYPES
// =============================================================================

/** A slot in the page row: a page number or a gap. */
export type PageSlot = { kind: 'page'; page: number } | { kind: 'gap'; id: 'start' | 'end' };

/** Props for the {@link Pagination} component. */
export interface IPaginationProps {
	/** Current page, 1-based. */
	page: number;
	/** Total number of pages. */
	pageCount: number;
	/** Fired with the new page. */
	onChange: (page: number) => void;
	/** Pages shown on each side of the current one. Defaults to 1. */
	siblingCount?: number;
	/** Total item count, for the "21–40 of 134" range. */
	totalItems?: number;
	/** Items per page (with `totalItems` and the size picker). */
	pageSize?: number;
	/** Page-size choices; shows a picker when set with `onPageSizeChange`. */
	pageSizes?: number[];
	/** Fired with a new page size. */
	onPageSizeChange?: (pageSize: number) => void;
	/** Accessible name of the nav landmark. Defaults to `'Pagination'`. */
	ariaLabel?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The page row: first page, last page, the current page with its siblings,
 * and a gap wherever pages are skipped. A gap never hides a single page (that
 * page is shown instead), so the row length stays constant.
 *
 * @param page - Current page, 1-based.
 * @param pageCount - Total pages.
 * @param siblingCount - Neighbours each side of the current page.
 * @returns Slots in display order.
 */
export function getPageSlots(page: number, pageCount: number, siblingCount = 1): PageSlot[] {
	if (pageCount <= 0) return [];
	const current = Math.min(Math.max(page, 1), pageCount);

	// Every page fits: first + last + current + siblings + two gaps.
	const fullWidth = siblingCount * 2 + 5;
	if (pageCount <= fullWidth) {
		return Array.from({ length: pageCount }, (_unused, index): PageSlot => ({ kind: 'page', page: index + 1 }));
	}

	const leftSibling = Math.max(current - siblingCount, 1);
	const rightSibling = Math.min(current + siblingCount, pageCount);
	const hasLeftGap = leftSibling > 3;
	const hasRightGap = rightSibling < pageCount - 2;
	const edgeRun = siblingCount * 2 + 3;
	const slots: PageSlot[] = [];

	/** Appends a run of pages. */
	function pushRange(from: number, to: number): void {
		for (let value = from; value <= to; value++) slots.push({ kind: 'page', page: value });
	}

	if (!hasLeftGap && hasRightGap) {
		pushRange(1, edgeRun);
		slots.push({ kind: 'gap', id: 'end' });
		slots.push({ kind: 'page', page: pageCount });
		return slots;
	}

	if (hasLeftGap && !hasRightGap) {
		slots.push({ kind: 'page', page: 1 });
		slots.push({ kind: 'gap', id: 'start' });
		pushRange(pageCount - edgeRun + 1, pageCount);
		return slots;
	}

	slots.push({ kind: 'page', page: 1 });
	slots.push({ kind: 'gap', id: 'start' });
	pushRange(leftSibling, rightSibling);
	slots.push({ kind: 'gap', id: 'end' });
	slots.push({ kind: 'page', page: pageCount });
	return slots;
}

/**
 * The "21–40 of 134" range text.
 *
 * @param page - Current page, 1-based.
 * @param pageSize - Items per page.
 * @param totalItems - Total items.
 * @returns The range text.
 */
export function formatPageRange(page: number, pageSize: number, totalItems: number): string {
	if (totalItems === 0) return '0 of 0';
	const start = (page - 1) * pageSize + 1;
	const end = Math.min(page * pageSize, totalItems);
	return `${start}–${end} of ${totalItems}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders page controls.
 *
 * @param props - {@link IPaginationProps}.
 * @returns The pagination nav landmark.
 */
export function Pagination({ page, pageCount, onChange, siblingCount = 1, totalItems, pageSize, pageSizes, onPageSizeChange, ariaLabel = 'Pagination' }: IPaginationProps): React.ReactElement {
	const slots = getPageSlots(page, pageCount, siblingCount);
	const isFirst = page <= 1;
	const isLast = page >= pageCount;

	/** Changes page within bounds. */
	function goTo(next: number): void {
		const bounded = Math.min(Math.max(next, 1), pageCount);
		if (bounded !== page) onChange(bounded);
	}

	const hasRange = totalItems !== undefined && pageSize !== undefined;
	const hasSizePicker = Boolean(pageSizes && pageSizes.length > 0 && onPageSizeChange && pageSize !== undefined);

	return (
		<nav className="rr-pagination" aria-label={ariaLabel}>
			{hasRange && <span className="rr-pagination__range rr-text-secondary">{formatPageRange(page, pageSize as number, totalItems as number)}</span>}
			{hasSizePicker && (
				<span className="rr-pagination__size">
					<Select small ariaLabel="Rows per page" options={(pageSizes as number[]).map((size) => ({ value: String(size), label: `${size} / page` }))} value={String(pageSize)} onChange={(value) => onPageSizeChange?.(Number(value))} />
				</span>
			)}
			<ul className="rr-pagination__pages">
				<li>
					<button type="button" className="rr-pagination__step" aria-label="Previous page" disabled={isFirst} onClick={() => goTo(page - 1)}>
						‹
					</button>
				</li>
				{slots.map((slot) => {
					if (slot.kind === 'gap') {
						return (
							<li key={`gap-${slot.id}`} className="rr-pagination__gap" aria-hidden="true">
								…
							</li>
						);
					}
					let ariaCurrent: 'page' | undefined;
					if (slot.page === page) ariaCurrent = 'page';
					return (
						<li key={slot.page}>
							<button type="button" className="rr-pagination__page" aria-current={ariaCurrent} aria-label={`Page ${slot.page}`} onClick={() => goTo(slot.page)}>
								{slot.page}
							</button>
						</li>
					);
				})}
				<li>
					<button type="button" className="rr-pagination__step" aria-label="Next page" disabled={isLast} onClick={() => goTo(page + 1)}>
						›
					</button>
				</li>
			</ul>
		</nav>
	);
}
