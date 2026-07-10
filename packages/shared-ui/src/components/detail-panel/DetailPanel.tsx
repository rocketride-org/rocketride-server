// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DetailPanel — the right slide-over drawer for entity details.
 *
 * The standard way to show an entity's details (connection, user, model, job):
 * a full-height panel that slides in from the right over a dimmed client area,
 * replacing detail modals. Centered modals (`commonStyles.modalDialog`) remain
 * only for confirmations and short forms.
 *
 * Anatomy (matches the style-guide 6.2 / mockup):
 * - a fixed EntityHeader (42px avatar/icon slot + title + secondary line + close),
 * - an optional underline tab strip taking the same {@link ViewMenuEntry} shape as
 *   PageViewControl/SidebarMenu (count badges reuse the shared {@link ViewMenuBadge}),
 * - a scrollable body composed from Section / LabelValue / Chip / StatusBadge /
 *   MiniContainer / Button.
 *
 * Accessibility: the panel is a modal dialog (`role="dialog"`, `aria-modal`,
 * `aria-label` = title). Opening moves focus to the close button; closing returns
 * focus to whatever was focused before, and Escape closes the drawer.
 */

import React, { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { ViewMenuEntry } from '../../types/viewMenu';
import { ViewMenuBadge } from '../page-view-control/ViewMenuBadge';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width when the caller does not override `width`. */
const DEFAULT_WIDTH = 560;

/** Multiplication-sign glyph used for the close affordance. */
const CLOSE_GLYPH = '×';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DetailPanel} component. */
export interface IDetailPanelProps {
	/** Whether the drawer is open. When false the component renders nothing. */
	open: boolean;
	/** Fired when the user dismisses the drawer (close glyph or Escape). */
	onClose: () => void;
	/** 42px round avatar/icon slot rendered at the start of the EntityHeader. */
	avatar?: ReactNode;
	/** Entity title — 17px/700. */
	title: string;
	/** Secondary line under the title — 12.5px, secondary colour. */
	subtitle?: string;
	/** Optional tab strip. Same entry shape as the ViewMenu renderers. */
	tabs?: ViewMenuEntry[];
	/** Id of the active tab (drawn with the brand underline). */
	activeTab?: string;
	/** Fired with a tab id when the user selects a tab. */
	onTabSelect?: (id: string) => void;
	/** Body content — composed from Section / LabelValue / Chip / StatusBadge /
	    MiniContainer / Button. Scrolls independently of the header and tabs. */
	children: ReactNode;
	/** Drawer width in px. Default {@link DEFAULT_WIDTH}. */
	width?: number;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Full-area dim backdrop; sits above content but below shell modals (2000).
	overlay: {
		position: 'fixed',
		inset: 0,
		zIndex: 1500,
		background: 'color-mix(in srgb, var(--rr-text-primary) 30%, transparent)',
	} as CSSProperties,

	// The drawer itself, pinned to the right edge. `entered` drives the slide-in.
	panel: (width: number, entered: boolean): CSSProperties => ({
		position: 'absolute',
		top: 0,
		right: 0,
		bottom: 0,
		width,
		background: 'var(--rr-bg-default)',
		boxShadow: '-10px 0 30px color-mix(in srgb, var(--rr-text-primary) 20%, transparent)',
		display: 'flex',
		flexDirection: 'column',
		// Slide-in: off-screen to flush-right over a 200ms ease-out transition.
		transform: entered ? 'translateX(0)' : 'translateX(100%)',
		transition: 'transform 200ms ease-out',
	}),

	// Fixed EntityHeader row: avatar + name/secondary + close.
	header: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		gap: 13,
		padding: '18px 20px 12px',
	} as CSSProperties,

	// 42px round slot centring the caller's avatar/icon node.
	avatar: {
		flexShrink: 0,
		width: 42,
		height: 42,
		borderRadius: '50%',
		overflow: 'hidden',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,

	// Stacked title + secondary line.
	who: {
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	title: {
		fontSize: 17,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	subtitle: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Close affordance — a real button (focus target) styled as the bare glyph.
	close: {
		marginLeft: 'auto',
		flexShrink: 0,
		background: 'none',
		border: 'none',
		padding: 0,
		fontFamily: 'inherit',
		fontSize: 18,
		lineHeight: 1,
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
	} as CSSProperties,

	// Underline tab strip (only rendered when `tabs` are provided).
	tabs: {
		flex: 'none',
		display: 'flex',
		gap: 24,
		padding: '0 20px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// A single tab; the active treatment (brand colour + underline) is layered on.
	tab: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 7,
		padding: '8px 2px 10px',
		fontSize: 13.5,
		fontWeight: 600,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		borderBottom: `2px solid ${active ? 'var(--rr-brand)' : 'transparent'}`,
		cursor: 'pointer',
	}),

	// Scrollable body; the header and tabs stay fixed above it.
	body: {
		flex: 1,
		overflowY: 'auto',
		padding: '6px 20px 20px',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the right slide-over detail drawer.
 *
 * @param props - {@link IDetailPanelProps}.
 * @returns The drawer element, or `null` when closed.
 */
export function DetailPanel({
	open,
	onClose,
	avatar,
	title,
	subtitle,
	tabs,
	activeTab,
	onTabSelect,
	children,
	width = DEFAULT_WIDTH,
}: IDetailPanelProps): React.ReactElement | null {
	// Drives the slide-in: false on mount (off-screen), flipped true next frame.
	const [entered, setEntered] = useState(false);
	// Focus target on open; also the button the close glyph fires.
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	// Element focused before opening, restored on close.
	const previouslyFocusedRef = useRef<Element | null>(null);
	// Latest onClose kept in a ref so the open effect need not depend on it
	// (which would re-run — and re-steal focus — on every parent render).
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// While open: lock page scroll, animate in, move focus in, and wire Escape.
	// Cleanup reverses every side effect and restores the prior focus.
	useEffect(() => {
		if (!open) {
			return;
		}
		// Remember what to restore focus to when the drawer closes.
		previouslyFocusedRef.current = document.activeElement;
		// Prevent the page behind the drawer from scrolling.
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		// Trigger the slide-in on the next frame so the transition actually runs.
		const enterRaf = requestAnimationFrame(() => setEntered(true));
		// Move focus into the panel (the close button).
		const focusRaf = requestAnimationFrame(() => closeButtonRef.current?.focus());
		// Escape closes the drawer.
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onCloseRef.current();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => {
			cancelAnimationFrame(enterRaf);
			cancelAnimationFrame(focusRaf);
			document.removeEventListener('keydown', onKeyDown);
			document.body.style.overflow = previousOverflow;
			// Reset so a subsequent open animates from off-screen again.
			setEntered(false);
			// Return focus to whatever held it before the drawer opened.
			const previous = previouslyFocusedRef.current;
			if (previous instanceof HTMLElement) {
				previous.focus();
			}
		};
	}, [open]);

	// Closed drawers render nothing at all.
	if (!open) {
		return null;
	}

	return (
		/* Dismissal is deliberate-only per the 2026-07-08 design decision: the
		   close glyph or Escape — clicking the dim backdrop must NOT close. */
		<div style={styles.overlay}>
			<div style={styles.panel(width, entered)} role="dialog" aria-modal="true" aria-label={title}>
				{/* Fixed EntityHeader: avatar slot + name/secondary + close glyph. */}
				<div style={styles.header}>
					{avatar != null && <div style={styles.avatar}>{avatar}</div>}
					<div style={styles.who}>
						<div style={styles.title}>{title}</div>
						{subtitle != null && <div style={styles.subtitle}>{subtitle}</div>}
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						style={styles.close}
						onClick={onClose}
						aria-label="Close"
					>
						{CLOSE_GLYPH}
					</button>
				</div>

				{/* Optional underline tab strip; count badges reuse ViewMenuBadge. */}
				{tabs != null && tabs.length > 0 && (
					<div style={styles.tabs} role="tablist">
						{tabs.map((entry) => {
							// The active tab carries the brand colour + underline.
							const isActive = entry.id === activeTab;
							return (
								<div
									key={entry.id}
									role="tab"
									aria-selected={isActive}
									tabIndex={0}
									style={styles.tab(isActive)}
									onClick={() => onTabSelect?.(entry.id)}
									onKeyDown={(e) => {
										// Enter / Space activate the tab, matching native button semantics.
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											onTabSelect?.(entry.id);
										}
									}}
								>
									{entry.label}
									{/* Count badge when the entry declares a count. */}
									{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
								</div>
							);
						})}
					</div>
				)}

				{/* Independently scrolling body composed of stock detail vocabulary. */}
				<div style={styles.body}>{children}</div>
			</div>
		</div>
	);
}
