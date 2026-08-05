// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarMenu — a plain, standard vertical menu-list component.
 *
 * Renders a declared {@link ViewMenu} as a vertical list. Not shell-routed:
 * an app composes zero, one, or several SidebarMenus inside the sidebar
 * content it registers via `useSidebarContent`, alongside any other content
 * it likes. The active entry is drawn as a selection-tinted pill; count
 * badges are right-aligned via the shared {@link ViewMenuBadge}.
 *
 * Multi-level (2026-07-18): an entry that declares `children` renders as an
 * expandable SECTION — a bolder row with a right-aligned chevron that
 * toggles its indented children. Sections never navigate, and at most ONE
 * section is open at a time (accordion): opening one closes the other, and
 * an `activeId` landing inside a closed section opens it. The section
 * containing the active entry starts open.
 *
 * Collapse-aware: while the shell sidebar is collapsed to its icon rail
 * (read from {@link useSidebarCollapsed}, or forced via the `collapsed`
 * prop) entries iconify automatically — icon-only squares with the label as
 * a tooltip and the count badge as a compact overlay. Sections flatten in
 * the rail: their children render as icon squares directly, so every
 * navigable entry keeps a one-click target.
 */

import React, { CSSProperties, useEffect, useState } from 'react';
import { ViewMenu, ViewMenuEntry } from '../../types/viewMenu';
import { ViewMenuBadge } from '../tab-control/ViewMenuBadge';
import { BxChevronDown, BxChevronRight } from '../BoxIcon';
import { useSidebarCollapsed } from './SidebarCollapsedContext';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link SidebarMenu} component. */
export interface ISidebarMenuProps {
	/** The declared menu whose entries render as the vertical list. */
	menu: ViewMenu;
	/** Id of the currently active entry (drawn as the brand-tinted pill). */
	activeId: string;
	/** Fired with an entry id when the user selects it. */
	onSelect: (id: string) => void;
	/** Section label above the menu, e.g. the owning document name. Optional. */
	sectionLabel?: string;
	/**
	 * Collapsed (icon-rail) rendering: entries draw icon-only (the entry's
	 * `icon`, or a first-letter glyph fallback) with the label as a tooltip,
	 * the section label hidden, and count badges shown as a compact overlay.
	 * When omitted, the flag falls back to the shell-provided
	 * {@link useSidebarCollapsed} context; an explicit prop always wins.
	 */
	collapsed?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Outer container padding around the item list.
	container: {
		padding: '2px 8px',
	} as CSSProperties,

	// Optional uppercase section header naming the owning document.
	sectionLabel: {
		padding: '16px 16px 6px',
		fontSize: 10.5,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.14em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Base row — active and hover treatments are layered on top.
	item: (active: boolean, hovered: boolean, disabled: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		margin: '1px 0',
		padding: '7px 10px',
		borderRadius: 7,
		fontSize: 13,
		// Disabled rows render muted with a default cursor and receive no hover
		// or active treatment (both are skipped below); otherwise the standard
		// primary tone with a pointer cursor.
		color: disabled ? 'var(--rr-text-disabled)' : 'var(--rr-text-primary)',
		cursor: disabled ? 'default' : 'pointer',
		// Constant 1px border (transparent when inactive) so toggling the
		// active pill never changes row height — no sibling reflow on select.
		// Longhands only: mixing the border shorthand with a borderColor
		// override makes React's style diffing leave the active color behind
		// when an item deactivates (the stuck-outline bug).
		borderWidth: 1,
		borderStyle: 'solid',
		borderColor: 'transparent',
		// Active: the theme's standard list highlight (--rr-bg-list-active /
		// --rr-fg-list-active) + bolder label. Border stays transparent. Never
		// applied to a disabled row.
		...(!disabled && active
			? {
					background: 'var(--rr-bg-list-active)',
					color: 'var(--rr-fg-list-active)',
					fontWeight: 600,
			  }
			: null),
		// Hover (non-active, non-disabled only): quiet list-hover fill.
		...(!disabled && !active && hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),

	// Label fills the row so the badge right-aligns to the trailing edge.
	label: {
		flex: 1,
	} as CSSProperties,

	// Leading icon slot on expanded rows (17px box matching the shell nav icons).
	// Active rows inherit the selection foreground so the glyph stays legible
	// on the highlight fill; inactive rows use the quiet secondary tone.
	itemIcon: (active: boolean, disabled: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 17,
		height: 17,
		flexShrink: 0,
		// Disabled and active rows let the glyph inherit the row colour (the
		// muted disabled tone / the selection foreground); inactive rows use
		// the quiet secondary tone.
		color: disabled || active ? 'inherit' : 'var(--rr-text-secondary)',
	}),

	// Collapsed (icon-rail) row: square, centered icon target with the same
	// active-pill treatment; the badge overlays the top-right corner.
	itemCollapsed: (active: boolean, hovered: boolean, disabled: boolean): CSSProperties => ({
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 36,
		height: 36,
		margin: '2px auto',
		borderRadius: 7,
		// Disabled rows render muted with a default cursor and no hover/active
		// treatment (both skipped below); otherwise the standard primary tone.
		color: disabled ? 'var(--rr-text-disabled)' : 'var(--rr-text-primary)',
		cursor: disabled ? 'default' : 'pointer',
		// Longhands only — see styles.item for why the shorthand is avoided.
		borderWidth: 1,
		borderStyle: 'solid',
		borderColor: 'transparent',
		// Active: the theme's standard list highlight (see styles.item). Never
		// applied to a disabled row.
		...(!disabled && active
			? {
					background: 'var(--rr-bg-list-active)',
					color: 'var(--rr-fg-list-active)',
			  }
			: null),
		...(!disabled && !active && hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),

	// Section header row — an expandable group, not a navigation target: the
	// item geometry with a bolder label and a right-aligned chevron. Never
	// takes the active pill (sections do not navigate), only the hover fill.
	sectionRow: (hovered: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		margin: '1px 0',
		padding: '7px 10px',
		borderRadius: 7,
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
		// Longhands only — see styles.item for why the shorthand is avoided.
		borderWidth: 1,
		borderStyle: 'solid',
		borderColor: 'transparent',
		...(hovered ? { background: 'var(--rr-bg-list-hover)' } : null),
	}),

	// The section chevron — quiet secondary tone at the row's trailing edge
	// (open: down, closed: right).
	sectionChevron: {
		display: 'inline-flex',
		alignItems: 'center',
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	} as CSSProperties,

	// Child rows indent under their section: the extra left padding equals
	// the parent's icon column (17px) + gap (10px), so a child's icon lines
	// up with its section's label.
	childIndent: {
		paddingLeft: 37,
	} as CSSProperties,

	// First-letter fallback glyph for entries that declare no icon.
	letterGlyph: {
		fontSize: 13,
		fontWeight: 700,
		lineHeight: 1,
	} as CSSProperties,

	// Compact badge overlay anchored to the icon's top-right corner.
	badgeOverlay: {
		position: 'absolute',
		top: -4,
		right: -4,
		transform: 'scale(0.85)',
		transformOrigin: 'top right',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a ViewMenu as a vertical sidebar list, with entries declaring
 * `children` rendered as expandable accordion sections (at most one open).
 *
 * @param props - {@link ISidebarMenuProps}.
 * @returns The sidebar menu element.
 */
export function SidebarMenu({ menu, activeId, onSelect, sectionLabel, collapsed }: ISidebarMenuProps): React.ReactElement {
	// Track the hovered entry so a non-active row can show the hover fill.
	const [hoveredId, setHoveredId] = useState<string | null>(null);

	// Collapse flag: an explicit prop wins; otherwise fall back to the
	// shell-provided context (false outside a provider).
	const ctxCollapsed = useSidebarCollapsed();
	const isCollapsed = collapsed ?? ctxCollapsed;

	/**
	 * Resolve the section (top-level entry with children) containing an
	 * entry id, or null when the id is a top-level entry / unknown.
	 *
	 * @param id - The entry id to locate.
	 * @returns The owning section's id, or null.
	 */
	const sectionOf = (id: string): string | null =>
		menu.entries.find((e) => e.children?.some((c) => c.id === id))?.id ?? null;

	// Accordion state: the ONE open section (null = all closed). Seeded with
	// the section containing the active entry so the current view is visible
	// on mount.
	const [openSectionId, setOpenSectionId] = useState<string | null>(() => sectionOf(activeId));

	// Follow navigation: an activeId landing inside a closed section opens
	// that section (and closes any other — the accordion invariant). Manual
	// toggles are otherwise left alone.
	useEffect(() => {
		const section = sectionOf(activeId);
		if (section) setOpenSectionId(section);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeId]);

	/** Toggle a section open/closed; opening one closes the other. */
	const toggleSection = (id: string): void => {
		setOpenSectionId((current) => (current === id ? null : id));
	};

	/**
	 * Enter / Space activation for a row, matching native button semantics. A
	 * disabled row ignores the keypress, mirroring its swallowed click.
	 *
	 * @param e - The keydown event.
	 * @param id - The entry id to select.
	 * @param disabled - Whether the row is disabled.
	 */
	const onItemKeyDown = (e: React.KeyboardEvent, id: string, disabled: boolean): void => {
		if (disabled) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect(id);
		}
	};

	/**
	 * Enter / Space on a section row toggles it, mirroring its click.
	 *
	 * @param e - The keydown event.
	 * @param id - The section entry id to toggle.
	 */
	const onSectionKeyDown = (e: React.KeyboardEvent, id: string): void => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleSection(id);
		}
	};

	/**
	 * One navigable row (top-level entry or a section child). Children
	 * indent so their icon column lines up with the section label.
	 *
	 * @param entry - The entry to render.
	 * @param indented - True for section children.
	 * @returns The row element.
	 */
	const renderItem = (entry: ViewMenuEntry, indented: boolean): React.ReactElement => {
		// Resolve per-row state for the composed style. A disabled entry
		// renders muted, takes no hover/active treatment, and its click
		// is swallowed (never calls onSelect).
		const isActive = entry.id === activeId;
		const isHovered = entry.id === hoveredId;
		const isDisabled = entry.disabled === true;
		return (
			<div
				key={entry.id}
				role="button"
				aria-current={isActive || undefined}
				aria-disabled={isDisabled || undefined}
				tabIndex={isDisabled ? -1 : 0}
				style={indented ? { ...styles.item(isActive, isHovered, isDisabled), ...styles.childIndent } : styles.item(isActive, isHovered, isDisabled)}
				onClick={() => { if (!isDisabled) onSelect(entry.id); }}
				onKeyDown={(e) => onItemKeyDown(e, entry.id, isDisabled)}
				onMouseEnter={() => setHoveredId(entry.id)}
				onMouseLeave={() => setHoveredId(null)}
			>
				{/* Optional leading icon — same glyph the collapsed rail shows. */}
				{entry.icon && <span style={styles.itemIcon(isActive, isDisabled)}>{entry.icon}</span>}
				<span style={styles.label}>{entry.label}</span>
				{/* Right-aligned count badge when the entry declares a count. */}
				{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
			</div>
		);
	};

	// Collapsed icon rail: sections flatten — their children render as icon
	// squares directly, so every navigable entry keeps a one-click target
	// (a closed/open distinction has nothing to show at rail width).
	if (isCollapsed) {
		const railEntries = menu.entries.flatMap((entry) => entry.children ?? [entry]);
		return (
			<div style={styles.container}>
				{railEntries.map((entry) => {
					const isActive = entry.id === activeId;
					const isHovered = entry.id === hoveredId;
					const isDisabled = entry.disabled === true;
					return (
						<div
							key={entry.id}
							title={entry.label}
							role="button"
							aria-label={entry.label}
							aria-current={isActive || undefined}
							aria-disabled={isDisabled || undefined}
							tabIndex={isDisabled ? -1 : 0}
							style={styles.itemCollapsed(isActive, isHovered, isDisabled)}
							onClick={() => { if (!isDisabled) onSelect(entry.id); }}
							onKeyDown={(e) => onItemKeyDown(e, entry.id, isDisabled)}
							onMouseEnter={() => setHoveredId(entry.id)}
							onMouseLeave={() => setHoveredId(null)}
						>
							{/* Declared icon, or a first-letter glyph fallback. */}
							{entry.icon ?? <span style={styles.letterGlyph}>{entry.label.charAt(0).toUpperCase()}</span>}
							{entry.count != null && (
								<span style={styles.badgeOverlay}>
									<ViewMenuBadge count={entry.count} severity={entry.severity} />
								</span>
							)}
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<div style={styles.container}>
			{/* Optional section header naming the owning section (expanded only). */}
			{sectionLabel && <div style={styles.sectionLabel}>{sectionLabel}</div>}
			{menu.entries.map((entry) => {
				// Plain entries render as navigable rows; entries with children
				// render as an accordion section row plus, while open, their
				// indented children.
				if (!entry.children) return renderItem(entry, false);
				const isOpen = entry.id === openSectionId;
				const isHovered = entry.id === hoveredId;
				return (
					<React.Fragment key={entry.id}>
						<div
							role="button"
							aria-expanded={isOpen}
							tabIndex={0}
							style={styles.sectionRow(isHovered)}
							onClick={() => toggleSection(entry.id)}
							onKeyDown={(e) => onSectionKeyDown(e, entry.id)}
							onMouseEnter={() => setHoveredId(entry.id)}
							onMouseLeave={() => setHoveredId(null)}
						>
							{/* Section icon shares the item icon slot (never active-tinted). */}
							{entry.icon && <span style={styles.itemIcon(false, false)}>{entry.icon}</span>}
							<span style={styles.label}>{entry.label}</span>
							{/* Open/closed chevron at the trailing edge. */}
							<span style={styles.sectionChevron}>
								{isOpen ? <BxChevronDown size={15} /> : <BxChevronRight size={15} />}
							</span>
						</div>
						{isOpen && entry.children.map((child) => renderItem(child, true))}
					</React.Fragment>
				);
			})}
		</div>
	);
}
