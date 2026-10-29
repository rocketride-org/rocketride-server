// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PageLayout — the scaffold for an app view: a header (title, subtitle,
 * breadcrumbs, actions), an optional toolbar row, the content, and optional
 * left and right sidebars (filters, navigation, details).
 *
 * Two looks:
 *   - `simple` (default): header and content on the page background.
 *   - `carded`: the toolbar and content sit in a raised card under a tinted
 *     header band, for list and detail pages.
 *
 * Sidebars are in-flow columns while the PAGE is wide and become overlay
 * drawers when it is narrow (`collapseBelow`, default 900px). The page
 * measures its own box, not the window: the shell already owns the one
 * viewport breakpoint (useIsCompact) for its own sidebar, and an app inside
 * the shell can be narrow on a wide screen. Drawers always start closed,
 * trap focus, close on Escape (one overlay layer at a time, shared with
 * Modal) or on the scrim, and give focus back to whatever opened them.
 *
 * Sidebar toggles: with the built-in header, a toggle appears for every
 * sidebar that has `showToggle` (default true). With a custom `header`,
 * place <PageSidebarToggle side="left" /> yourself, or drive the sidebars
 * from anywhere inside the page with usePageLayout().
 *
 * Scrolling: `scroll="content"` (default) keeps the header in place and
 * scrolls the content and each sidebar separately; `scroll="page"` scrolls
 * the whole page with a sticky header.
 *
 * Built on `.rr-page-layout` from components.css.
 */

import React, { createContext, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { acquireOverlayLayer, FOCUSABLE_SELECTOR, isTopOverlayLayer, releaseOverlayLayer, trapFocus } from '../modal/Modal';
import { Breadcrumbs, IBreadcrumb } from '../breadcrumbs/Breadcrumbs';
import { IconButton } from '../icon-button/IconButton';
import { DEFAULT_COLLAPSE_BELOW, DEFAULT_SIDEBAR_WIDTH, getSidebarMode, ISidebarOpenState, openStateForMode, setSideOpen, SidebarMode } from './pageLayoutState';

// =============================================================================
// TYPES
// =============================================================================

/** Which sidebar. */
export type PageSidebarSide = 'left' | 'right';

/** One sidebar of a {@link PageLayout}. */
export interface IPageSidebar {
	/** Sidebar content. */
	content: ReactNode;
	/** Accessible name; also the toggle's label (e.g. "Filters"). */
	label: string;
	/** Width in px. Defaults to 280. */
	width?: number;
	/** Open state while the page is wide (uncontrolled). Left defaults to true, right to false. */
	defaultOpen?: boolean;
	/** Open state (controlled). */
	open?: boolean;
	/** Fired with the new open state. */
	onOpenChange?: (isOpen: boolean) => void;
	/** Render a toggle in the built-in header. Defaults to true. */
	showToggle?: boolean;
}

/** Props for the {@link PageLayout} component. */
export interface IPageLayoutProps {
	/** Page content. */
	children: ReactNode;
	/** Title for the built-in header. */
	title?: ReactNode;
	/** One line under the title. */
	subtitle?: ReactNode;
	/** Right-aligned header actions (one primary Button at most). */
	actions?: ReactNode;
	/** Trail shown above the title. */
	breadcrumbs?: IBreadcrumb[];
	/** Heading level of the title. Defaults to 1. */
	headingLevel?: 1 | 2 | 3;
	/** Replace the built-in header entirely. */
	header?: ReactNode;
	/** A row under the header: filters, search, tabs. */
	toolbar?: ReactNode;
	/** Left sidebar (navigation, filters). */
	leftSidebar?: IPageSidebar;
	/** Right sidebar (details, properties). */
	rightSidebar?: IPageSidebar;
	/** Look. Defaults to `'simple'`. */
	variant?: 'simple' | 'carded';
	/** Constrain the content to a readable width (forms, settings). */
	contentWidth?: 'full' | 'narrow';
	/** What scrolls. Defaults to `'content'`. */
	scroll?: 'content' | 'page';
	/** Page width (px) below which sidebars become drawers. Defaults to 900. */
	collapseBelow?: number;
}

/** One side's controls, from {@link usePageLayout}. */
export interface IPageSidebarControl {
	/** Whether this page has the sidebar at all. */
	exists: boolean;
	/** Whether it is open. */
	isOpen: boolean;
	/** Open it. */
	open: () => void;
	/** Close it. */
	close: () => void;
	/** Flip it. */
	toggle: () => void;
	/** The sidebar element's id (for `aria-controls`). */
	id: string;
	/** Its accessible name. */
	label: string;
}

/** What {@link usePageLayout} returns. */
export interface IPageLayoutContext {
	/** `'drawer'` while the page is narrow, else `'column'`. */
	mode: SidebarMode;
	/** Left sidebar controls. */
	left: IPageSidebarControl;
	/** Right sidebar controls. */
	right: IPageSidebarControl;
}

/** Props for the {@link PageSidebarToggle} component. */
export interface IPageSidebarToggleProps {
	/** Which sidebar it toggles. */
	side: PageSidebarSide;
	/** Compact size. */
	small?: boolean;
}

// =============================================================================
// CONTEXT
// =============================================================================

const PageLayoutContext = createContext<IPageLayoutContext | null>(null);

/**
 * Sidebar controls for the enclosing PageLayout.
 *
 * @returns The page layout context, or null outside a PageLayout.
 */
export function usePageLayout(): IPageLayoutContext | null {
	return useContext(PageLayoutContext);
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Tracks an element's width with a ResizeObserver.
 *
 * @param ref - The element.
 * @returns Its current width in px (0 until measured).
 */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === 'undefined') return undefined;
		setWidth(element.getBoundingClientRect().width);
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/**
 * While a drawer is open: join the overlay stack, move focus in, trap Tab,
 * close on Escape (top layer only), and restore focus on close.
 *
 * @param isActive - Whether the drawer is open in drawer mode.
 * @param drawerRef - The drawer element.
 * @param onClose - Closes the drawer.
 */
function useDrawerBehavior(isActive: boolean, drawerRef: React.RefObject<HTMLElement | null>, onClose: () => void): void {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!isActive) return undefined;
		const drawer = drawerRef.current;
		if (!drawer) return undefined;

		const opener = document.activeElement as HTMLElement | null;
		const layer = acquireOverlayLayer(false);
		const first = drawer.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
		if (first) {
			first.focus();
		} else {
			drawer.focus();
		}

		/** Escape closes; Tab stays inside the drawer. */
		function handleKeyDown(event: KeyboardEvent): void {
			if (!isTopOverlayLayer(layer)) return;
			if (event.key === 'Escape') {
				event.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (event.key === 'Tab' && drawer) trapFocus(event, drawer);
		}

		document.addEventListener('keydown', handleKeyDown);
		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			releaseOverlayLayer(layer);
			if (opener && document.contains(opener)) opener.focus();
		};
	}, [isActive, drawerRef]);
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * An IconButton that toggles one of the enclosing page's sidebars.
 *
 * @param props - {@link IPageSidebarToggleProps}.
 * @returns The toggle, or nothing outside a PageLayout / without that sidebar.
 */
export function PageSidebarToggle({ side, small = true }: IPageSidebarToggleProps): React.ReactElement | null {
	const layout = usePageLayout();
	if (!layout) return null;
	const control = layout[side];
	if (!control.exists) return null;

	let icon = <PanelLeft size={16} aria-hidden="true" />;
	if (side === 'right') icon = <PanelRight size={16} aria-hidden="true" />;

	let label = `Show ${control.label}`;
	if (control.isOpen) label = `Hide ${control.label}`;

	return (
		<IconButton label={label} small={small} ariaExpanded={control.isOpen} ariaControls={control.id} onClick={control.toggle}>
			{icon}
		</IconButton>
	);
}

/**
 * Renders a page scaffold with header, toolbar, content and sidebars.
 *
 * @param props - {@link IPageLayoutProps}.
 * @returns The page element.
 */
export function PageLayout({ children, title, subtitle, actions, breadcrumbs, headingLevel = 1, header, toolbar, leftSidebar, rightSidebar, variant = 'simple', contentWidth = 'full', scroll = 'content', collapseBelow = DEFAULT_COLLAPSE_BELOW }: IPageLayoutProps): React.ReactElement {
	const rootRef = useRef<HTMLDivElement>(null);
	const leftRef = useRef<HTMLDivElement>(null);
	const rightRef = useRef<HTMLDivElement>(null);
	const baseId = useId();
	const width = useElementWidth(rootRef);
	const mode = getSidebarMode(width, collapseBelow);

	const defaults: ISidebarOpenState = { left: leftSidebar?.defaultOpen ?? true, right: rightSidebar?.defaultOpen ?? false };
	const [internalOpen, setInternalOpen] = useState<ISidebarOpenState>(defaults);
	const previousModeRef = useRef<SidebarMode>(mode);

	// Effective state: a controlled side wins over the internal one.
	const openState: ISidebarOpenState = {
		left: Boolean(leftSidebar) && (leftSidebar?.open ?? internalOpen.left),
		right: Boolean(rightSidebar) && (rightSidebar?.open ?? internalOpen.right),
	};

	/** Applies a new open state: internal for uncontrolled sides, callbacks for all that changed. */
	const applyOpenState = useCallback(
		(next: ISidebarOpenState) => {
			setInternalOpen(next);
			if (leftSidebar && next.left !== openState.left) leftSidebar.onOpenChange?.(next.left);
			if (rightSidebar && next.right !== openState.right) rightSidebar.onOpenChange?.(next.right);
		},
		[leftSidebar, rightSidebar, openState.left, openState.right]
	);

	// Crossing the breakpoint resets the sidebars for the new mode.
	useEffect(() => {
		if (previousModeRef.current === mode) return;
		previousModeRef.current = mode;
		applyOpenState(openStateForMode(mode, defaults));
		// defaults are read at the moment of the crossing only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode]);

	/** Sets one side's state (opening a drawer closes the other drawer). */
	function setSide(side: PageSidebarSide, isOpen: boolean): void {
		applyOpenState(setSideOpen(openState, side, isOpen, mode));
	}

	const isDrawerMode = mode === 'drawer';
	useDrawerBehavior(isDrawerMode && openState.left, leftRef, () => setSide('left', false));
	useDrawerBehavior(isDrawerMode && openState.right, rightRef, () => setSide('right', false));

	/** Builds one side's controls for the context. */
	function control(side: PageSidebarSide, sidebar: IPageSidebar | undefined): IPageSidebarControl {
		return {
			exists: Boolean(sidebar),
			isOpen: openState[side],
			open: () => setSide(side, true),
			close: () => setSide(side, false),
			toggle: () => setSide(side, !openState[side]),
			id: `${baseId}-${side}`,
			label: sidebar?.label ?? '',
		};
	}

	const context: IPageLayoutContext = { mode, left: control('left', leftSidebar), right: control('right', rightSidebar) };

	/** Renders one sidebar as a column or a drawer. */
	function renderSidebar(side: PageSidebarSide, sidebar: IPageSidebar | undefined, ref: React.RefObject<HTMLElement>): ReactNode {
		if (!sidebar) return null;
		const isOpen = openState[side];
		const sidebarWidth = sidebar.width ?? DEFAULT_SIDEBAR_WIDTH;

		// One element in both modes (so sidebar state survives crossing the
		// breakpoint): a labelled complementary region as a column, a modal
		// dialog as a drawer. A div, because <aside> may not be a dialog.
		let role = 'complementary';
		let ariaModal: boolean | undefined;
		if (isDrawerMode) {
			role = 'dialog';
			ariaModal = true;
		}

		return (
			<div ref={ref as React.RefObject<HTMLDivElement>} id={`${baseId}-${side}`} className={`rr-page-layout__sidebar rr-page-layout__sidebar--${side}`} data-mode={mode} aria-label={sidebar.label} role={role} aria-modal={ariaModal} hidden={!isOpen} tabIndex={-1} style={{ width: sidebarWidth }}>
				{sidebar.content}
			</div>
		);
	}

	const Heading = `h${headingLevel}` as 'h1';
	const hasBuiltInHeader = !header && (title || subtitle || actions || breadcrumbs);
	const showLeftToggle = Boolean(leftSidebar) && leftSidebar?.showToggle !== false;
	const showRightToggle = Boolean(rightSidebar) && rightSidebar?.showToggle !== false;

	let headerNode: ReactNode = header;
	if (hasBuiltInHeader) {
		headerNode = (
			<div className="rr-page-layout__header">
				{breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
				<div className="rr-page-layout__title-row">
					{showLeftToggle && <PageSidebarToggle side="left" />}
					<div className="rr-page-layout__titles">
						{title && <Heading className="rr-page-layout__title">{title}</Heading>}
						{subtitle && <p className="rr-page-layout__subtitle">{subtitle}</p>}
					</div>
					{actions && <div className="rr-page-layout__actions">{actions}</div>}
					{showRightToggle && <PageSidebarToggle side="right" />}
				</div>
			</div>
		);
	}

	let rootClassName = `rr-page-layout rr-page-layout--${variant} rr-page-layout--scroll-${scroll}`;
	if (contentWidth === 'narrow') rootClassName += ' rr-page-layout--narrow';

	const isScrimShown = isDrawerMode && (openState.left || openState.right);

	// A scrolling content area must be reachable from the keyboard even when
	// it holds nothing focusable (WCAG 2.1.1), so it is a labelled, focusable
	// region while it owns the scroll.
	let contentScrollProps: React.HTMLAttributes<HTMLDivElement> = {};
	if (scroll === 'content') {
		let contentLabel = 'Page content';
		if (typeof title === 'string') contentLabel = `${title} content`;
		contentScrollProps = { tabIndex: 0, role: 'region', 'aria-label': contentLabel };
	}

	return (
		<PageLayoutContext.Provider value={context}>
			<div ref={rootRef} className={rootClassName} data-mode={mode}>
				{headerNode && <div className="rr-page-layout__header-wrap">{headerNode}</div>}
				<div className="rr-page-layout__body">
					{renderSidebar('left', leftSidebar, leftRef as React.RefObject<HTMLElement>)}
					<div className="rr-page-layout__main">
						{toolbar && <div className="rr-page-layout__toolbar">{toolbar}</div>}
						<div className="rr-page-layout__content" {...contentScrollProps}>
							<div className="rr-page-layout__content-inner">{children}</div>
						</div>
					</div>
					{renderSidebar('right', rightSidebar, rightRef as React.RefObject<HTMLElement>)}
				</div>
				{/* The scrim covers the whole page, header included, so nothing
				    behind a modal drawer stays clickable. */}
				{isScrimShown && (
					<div
						className="rr-page-layout__scrim"
						aria-hidden="true"
						onClick={() => {
							applyOpenState({ left: false, right: false });
						}}
					/>
				)}
			</div>
		</PageLayoutContext.Provider>
	);
}
