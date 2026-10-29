// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Accordion — stacked sections that expand and collapse: settings groups,
 * FAQs, advanced options, run details. A one-item Accordion is a plain
 * disclosure ("Show advanced").
 *
 * Follows the WAI-ARIA accordion pattern: each header is a heading holding a
 * button with `aria-expanded`; each panel is a region labelled by its
 * header. Arrow Up/Down move between headers, Home/End jump. Single-expand
 * by default; `multiple` lets several stay open. Controlled (`expanded` +
 * `onChange`) or uncontrolled (`defaultExpanded`). Collapsed panels stay
 * mounted (hidden), so form state inside them survives.
 *
 * Built on `.rr-accordion` from components.css.
 */

import React, { ReactNode, useId, useRef, useState } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** One section of an {@link Accordion}. */
export interface IAccordionItem {
	/** Stable id. */
	id: string;
	/** Header text. */
	title: ReactNode;
	/** Secondary text on the right of the header (a count, a status). */
	meta?: ReactNode;
	/** Panel content. */
	content: ReactNode;
	/** Header cannot be toggled. */
	disabled?: boolean;
}

/** Props for the {@link Accordion} component. */
export interface IAccordionProps {
	/** Sections, in order. */
	items: IAccordionItem[];
	/** Expanded ids (controlled). */
	expanded?: string[];
	/** Initially expanded ids (uncontrolled). */
	defaultExpanded?: string[];
	/** Fired with the new expanded ids. */
	onChange?: (expanded: string[]) => void;
	/** Allow several sections open at once. */
	multiple?: boolean;
	/** Heading level of the headers. Defaults to 3. */
	headingLevel?: 2 | 3 | 4 | 5 | 6;
	/** Drop the outer border (when nested in a card). */
	flush?: boolean;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The expanded ids after toggling one section.
 *
 * @param current - Currently expanded ids.
 * @param id - The section toggled.
 * @param isMultiple - Whether several may stay open.
 * @returns The new expanded ids.
 */
export function toggleExpanded(current: readonly string[], id: string, isMultiple: boolean): string[] {
	if (current.includes(id)) return current.filter((openId) => openId !== id);
	if (isMultiple) return [...current, id];
	return [id];
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders expandable sections.
 *
 * @param props - {@link IAccordionProps}.
 * @returns The accordion element.
 */
export function Accordion({ items, expanded, defaultExpanded = [], onChange, multiple = false, headingLevel = 3, flush = false }: IAccordionProps): React.ReactElement {
	const [internalExpanded, setInternalExpanded] = useState<string[]>(defaultExpanded);
	const headerRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const baseId = useId();

	let openIds = internalExpanded;
	if (expanded !== undefined) openIds = expanded;

	/** Toggles a section and reports the change. */
	function toggle(id: string): void {
		const next = toggleExpanded(openIds, id, multiple);
		if (expanded === undefined) setInternalExpanded(next);
		onChange?.(next);
	}

	/** Moves focus between enabled headers. */
	function focusHeader(from: number, direction: 1 | -1 | 'first' | 'last'): void {
		const enabled = items.map((item, index) => ({ index, disabled: item.disabled })).filter((entry) => !entry.disabled);
		if (enabled.length === 0) return;
		let target = enabled[0].index;
		if (direction === 'last') target = enabled[enabled.length - 1].index;
		if (direction === 1 || direction === -1) {
			const position = enabled.findIndex((entry) => entry.index === from);
			target = enabled[(position + direction + enabled.length) % enabled.length].index;
		}
		headerRefs.current[target]?.focus();
	}

	/** Arrow / Home / End between headers. */
	function handleKeyDown(event: React.KeyboardEvent, index: number): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusHeader(index, 1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusHeader(index, -1);
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			focusHeader(index, 'first');
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			focusHeader(index, 'last');
		}
	}

	const Heading = `h${headingLevel}` as 'h3';
	let rootClassName = 'rr-accordion';
	if (flush) rootClassName += ' rr-accordion--flush';

	return (
		<div className={rootClassName}>
			{items.map((item, index) => {
				const isOpen = openIds.includes(item.id);
				const headerId = `${baseId}-header-${index}`;
				const panelId = `${baseId}-panel-${index}`;
				return (
					<div key={item.id} className="rr-accordion__item" data-open={isOpen || undefined}>
						<Heading className="rr-accordion__heading">
							<button
								ref={(element) => {
									headerRefs.current[index] = element;
								}}
								type="button"
								id={headerId}
								className="rr-accordion__trigger"
								aria-expanded={isOpen}
								aria-controls={panelId}
								disabled={item.disabled}
								onClick={() => toggle(item.id)}
								onKeyDown={(event) => handleKeyDown(event, index)}
							>
								<span className="rr-accordion__chevron" aria-hidden="true" />
								<span className="rr-accordion__title">{item.title}</span>
								{item.meta && <span className="rr-accordion__meta">{item.meta}</span>}
							</button>
						</Heading>
						<div id={panelId} role="region" aria-labelledby={headerId} className="rr-accordion__panel" hidden={!isOpen}>
							{item.content}
						</div>
					</div>
				);
			})}
		</div>
	);
}
