// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Common style definitions for shared-ui components.
 *
 * All styles use --rr-* CSS custom property tokens so they automatically
 * adapt to light/dark themes and VS Code theme overrides.
 *
 * HOW TO USE THIS FILE
 * --------------------
 * Import only what you need:
 *   import { commonStyles } from '../../themes/styles';
 *   <div style={commonStyles.card}> ... </div>
 *
 * Only add a style here if it is genuinely reused across two or more
 * unrelated components. Single-use styles belong inline in the component.
 *
 * STYLE GROUPS (how they compose together)
 * -----------------------------------------
 *  Cards:              card → cardHeader + cardBody  (or cardFlat for headerless)
 *  Sections:           section → sectionHeader → sectionHeaderLabel
 *  Buttons:            buttonPrimary / buttonSecondary / buttonDanger + buttonDisabled
 *  Toggle buttons:     toggleGroup → toggleButton(active)
 *  Page layout:        columnFill → headerBar + tabContent (or viewPadding)
 *  Overlays/dialogs:   overlay or modalOverlay → dialog
 *  Context menus:      popupMenu → menuRow (hover sets rr-bg-list-hover)
 *  Tables:             <table> → tableHeader (th) + tableCell (td)
 *  Status dots:        indicatorBase is the base; use a variant (Success/Info/Warning/Error/Muted) directly
 *  Empty states:       emptyState (container card) + empty (inline text fallback)
 *  Lists/trees:        listRow(active) for each item row
 *  Badges:             badge + inline backgroundColor/color per variant
 *  Icon boxes:         iconBox + inline width/height/borderRadius per size
 */

import type { CSSProperties } from 'react';

// =============================================================================
// CARDS
// =============================================================================
// A card is a bordered surface that groups related content.
// Standard composition: wrap with `card`, then add a `cardHeader` child and a
// `cardBody` child.  If there is no header, use `cardFlat` instead (it adds
// its own padding).
// =============================================================================

/**
 * Card shell — bordered container with rounded corners and paper background.
 * Use as the outermost wrapper.  Add `cardHeader` and `cardBody` inside.
 * Set overflow:hidden so rounded corners clip child backgrounds correctly.
 */
const card: CSSProperties = {
	background: 'var(--rr-bg-paper)',
	border: '1px solid var(--rr-border)',
	borderRadius: 8,
	overflow: 'hidden',
};

/**
 * Card header bar — sits flush at the top of a `card`.
 * Contains a title (left) and optional actions (right) via space-between flex.
 * Uses the inactive title-bar background to visually separate it from the body.
 * Pair with `card` + `cardBody`.
 */
const cardHeader: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	padding: '12px 16px',
	background: 'var(--rr-bg-titleBar-inactive)',
	fontSize: 13,
	fontWeight: 600,
	color: 'var(--rr-text-primary)',
};

/**
 * Card body — scrollable content area with standard 16px padding.
 * Sits below `cardHeader` inside a `card`.
 */
const cardBody: CSSProperties = {
	padding: 16,
};

/**
 * Flat card (no header) — same bordered shell as `card` but with built-in
 * padding.  Use when you need a simple contained surface without a title bar.
 */
const cardFlat: CSSProperties = {
	...card,
	padding: 16,
};

// =============================================================================
// SECTIONS
// =============================================================================
// A section is a labelled vertical block within a larger view or card body.
// Composition: section → sectionHeader (with sectionHeaderLabel on the left
// and optional controls on the right) → content children.
// =============================================================================

/**
 * Section container — full-width vertical flex column with 16px gap between
 * its children.  Use to wrap a heading + content block inside a view or card.
 */
const section: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	gap: 16,
	width: '100%',
};

/**
 * Section header row — space-between flex row that holds the label on the
 * left and optional action controls on the right.
 * Place `sectionHeaderLabel` as the first child.
 */
const sectionHeader: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	padding: '8px 0',
};

/**
 * Section header label text — bold 13px primary-coloured title.
 * Use as the left child inside `sectionHeader`.
 */
const sectionHeaderLabel: CSSProperties = {
	fontSize: 13,
	fontWeight: 600,
	color: 'var(--rr-text-primary)',
};

// =============================================================================
// BUTTONS
// =============================================================================
// All button styles share the same size/radius/transition defaults.
// Apply `buttonDisabled` (spread or Object.assign) when the button is disabled
// rather than repeating opacity/cursor inline.
// Toggle buttons are a separate sub-group: use toggleGroup + toggleButton(active).
// =============================================================================

/**
 * Primary action button — brand-coloured fill for the main CTA on a surface.
 * Examples: "Save", "Connect", "Create".
 * Spread `buttonDisabled` on top when the button is in a disabled state.
 */
const buttonPrimary: CSSProperties = {
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: 'none',
	cursor: 'pointer',
	backgroundColor: 'var(--rr-brand)',
	color: 'var(--rr-fg-button)',
	transition: 'opacity 0.15s',
};

/**
 * Danger button — solid error-coloured fill for irreversible destructive
 * actions that are the primary option in a danger dialog (e.g. "Delete account").
 * Extends `buttonPrimary`; spread `buttonDisabled` when disabled.
 */
const buttonDanger: CSSProperties = {
	...buttonPrimary,
	backgroundColor: 'var(--rr-color-error)',
};

/**
 * Danger outline button — transparent background with error-coloured border
 * and text.  Use for destructive secondary actions (e.g. "Remove" alongside a
 * neutral confirm button) where you want the danger signal without the heavy
 * solid fill.
 */
const buttonDangerOutline: CSSProperties = {
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: '1px solid var(--rr-color-error)',
	cursor: 'pointer',
	backgroundColor: 'transparent',
	color: 'var(--rr-color-error)',
	transition: 'opacity 0.15s',
};

/**
 * Secondary / outline button — subdued border-only style for cancel, back, or
 * non-primary actions that live alongside a `buttonPrimary`.
 * Examples: "Cancel", "Back", "Close".
 */
const buttonSecondary: CSSProperties = {
	padding: '6px 16px',
	fontSize: 'var(--rr-font-size-widget)',
	fontWeight: 500,
	borderRadius: 6,
	border: '1px solid var(--rr-border)',
	cursor: 'pointer',
	backgroundColor: 'var(--rr-bg-paper)',
	color: 'var(--rr-text-secondary)',
	transition: 'opacity 0.15s',
};

/**
 * Disabled button modifier — halves opacity and switches cursor to default.
 * Spread over any button style when the action is unavailable:
 *   style={{ ...commonStyles.buttonPrimary, ...(disabled && commonStyles.buttonDisabled) }}
 * Do NOT use this for loading states — show a spinner instead.
 */
const buttonDisabled: CSSProperties = {
	opacity: 0.5,
	cursor: 'default',
};

/**
 * Small toggle button (function) — renders active/inactive pill for segmented
 * controls such as time-range selectors or view-mode switchers.
 * Always wrap a group of these in `toggleGroup`.
 * @param active - true when this option is the currently selected one.
 * @example
 *   <div style={commonStyles.toggleGroup}>
 *     {['1h','24h','7d'].map(r =>
 *       <button key={r} style={commonStyles.toggleButton(range === r)} onClick={() => setRange(r)}>{r}</button>
 *     )}
 *   </div>
 */
const toggleButton = (active: boolean): CSSProperties => ({
	padding: '2px 8px',
	fontSize: 11,
	border: active ? '1px solid var(--rr-brand)' : '1px solid var(--rr-border)',
	borderRadius: 3,
	cursor: 'pointer',
	backgroundColor: active ? 'var(--rr-brand)' : 'transparent',
	color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-secondary)',
	transition: 'background-color 0.15s, color 0.15s',
});

/**
 * Toggle button group container — flex row with 4px gap.
 * Wrap a set of `toggleButton` elements in this.
 */
const toggleGroup: CSSProperties = {
	display: 'flex',
	gap: 4,
};

// =============================================================================
// LAYOUT
// =============================================================================
// These styles handle the macro structure of views and pages.
//
// Typical full-page view composition:
//   columnFill               ← root div that fills the shell pane
//     headerBar              ← fixed-height top bar (title + actions)
//     tabContent             ← scrollable body (clears the overlay tab bar)
//
// For views without a tab bar, use viewPadding instead of tabContent.
// splitHeader is for a two-column row inside a content area (not the page top).
// =============================================================================

/**
 * Two-column header inside a content area — content left, action buttons right.
 * Use at the top of a scrollable content area (NOT a page header bar).
 * For the page-level header use `headerBar` instead.
 */
const splitHeader: CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'flex-start',
	gap: 16,
	marginBottom: 16,
};

/**
 * Tab content area — padded wrapper for views with an overlay pill bar.
 * Top padding clears the absolutely-positioned bar (15px + 38px + 15px + 11px = 79px).
 * Centres content to a max-width of 800px.
 * Scrolling is handled by the TabPanel panel div, not this element.
 */
const tabContent: CSSProperties = {
	padding: '79px 30px 30px',
	maxWidth: 800,
	margin: '0 auto',
};

/**
 * @deprecated Use `tabContent` instead.
 * Simple padded scrollable area for views without a tab bar overlay.
 */
const viewPadding: CSSProperties = {
	padding: 16,
	flex: 1,
	minHeight: 0,
	overflow: 'auto',
};

/**
 * Full-height flex column — fills parent width and height, stacks children
 * vertically.  Apply to every view root that must fill its shell container.
 * Always set on the outermost div of a view component.
 * `minHeight: 0` prevents flex overflow bugs in nested scroll containers.
 */
const columnFill: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	width: '100%',
	height: '100%',
	minHeight: 0,
};

/**
 * Page / view header bar — fixed-height (56px) flex row at the top of a view.
 * Holds the view title on the left and primary action buttons on the right.
 * Use as the first child of `columnFill`, above `tabContent` or `viewPadding`.
 * Has a bottom border to separate it from the scrollable body.
 */
const headerBar: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	padding: '0 24px',
	height: 56,
	borderBottom: '1px solid var(--rr-border)',
	backgroundColor: 'var(--rr-bg-paper)',
	flexShrink: 0,
};

/**
 * Horizontal divider / separator line — full-width 1px border-coloured rule.
 * Use between menu sections, form groups, or list segments.
 * Also used as a menu separator inside `popupMenu`.
 */
const divider: CSSProperties = {
	width: '100%',
	height: 1,
	background: 'var(--rr-border)',
	margin: '4px 0',
};

// =============================================================================
// TEXT
// =============================================================================
// Standalone text helpers for common patterns that do not belong to a
// specific widget.  See also TEXT UTILITIES below for truncation/mono/labels.
// =============================================================================

/**
 * Empty state inline message — centred, disabled-colour text with 32px padding.
 * Use inside a list or panel when there is nothing to display yet, but you
 * don't need the full `emptyState` card (e.g. a small panel with no rows).
 * For full-page empty states use the `emptyState` card style instead.
 */
const empty: CSSProperties = {
	color: 'var(--rr-text-disabled)',
	textAlign: 'center',
	padding: 32,
};

/**
 * Muted secondary text — 12px, secondary colour.
 * Use for captions, helper text, or metadata below a primary value.
 */
const textMuted: CSSProperties = {
	color: 'var(--rr-text-secondary)',
	fontSize: 12,
};

// =============================================================================
// TABLES
// =============================================================================
// Apply to <th> and <td> elements inside a plain HTML <table>.
// The table itself should be styled inline (width:100%, borderCollapse:collapse).
// tableHeader and tableCell are the only two parts needed for a basic table.
// =============================================================================

/**
 * Table header cell (<th>) — uppercase, spaced, 10px, disabled colour.
 * Apply directly to <th> elements.  Has a bottom border that acts as the
 * column-header separator.
 */
const tableHeader: CSSProperties = {
	textAlign: 'left',
	padding: '8px 14px',
	fontSize: 10,
	textTransform: 'uppercase',
	letterSpacing: '0.6px',
	color: 'var(--rr-text-disabled)',
	borderBottom: '1px solid var(--rr-border)',
	fontWeight: 600,
};

/**
 * Table body cell (<td>) — 10px vertical padding, subtle 30%-opacity bottom
 * border so row separators are lighter than the header border.
 * Apply directly to <td> elements.
 */
const tableCell: CSSProperties = {
	padding: '10px 14px',
	borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
	verticalAlign: 'middle',
};

// =============================================================================
// STATUS INDICATORS
// =============================================================================
// Small coloured dots (8×8px) used to show connection/health status inline.
// Always use a specific variant (indicatorSuccess, indicatorError, etc.)
// directly — do NOT spread indicatorBase manually unless you are adding a new
// variant here.
//
// Typical usage alongside text:
//   <div style={{ display:'flex', alignItems:'center', gap:6 }}>
//     <span style={commonStyles.indicatorSuccess} />
//     Connected
//   </div>
// =============================================================================

/** @internal Base shape — 8×8px circle.  Use a named variant, not this directly. */
const indicatorBase: CSSProperties = {
	width: 8,
	height: 8,
	borderRadius: '50%',
};

/** Green dot with glow — active / connected / healthy. */
const indicatorSuccess: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-success)',
	boxShadow: '0 0 4px var(--rr-color-success)',
};

/** Blue dot — informational / in-progress (no glow). */
const indicatorInfo: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-info)',
};

/** Amber dot — warning / degraded. */
const indicatorWarning: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-warning)',
};

/** Red dot — error / disconnected / failed. */
const indicatorError: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-color-error)',
};

/** Faded grey dot — inactive / disabled / unknown state. */
const indicatorMuted: CSSProperties = {
	...indicatorBase,
	backgroundColor: 'var(--rr-text-secondary)',
	opacity: 0.5,
};

// =============================================================================
// TEXT UTILITIES
// =============================================================================
// Composable text modifiers — spread these into inline styles alongside other
// style objects when you need truncation, monospace, or label formatting.
// =============================================================================

/**
 * Truncate overflow text with an ellipsis.
 * IMPORTANT: the parent element must have a bounded width.  For flex children,
 * also add `flex: 1` and `minWidth: 0` to the element (without minWidth: 0
 * flex items do not shrink below their content width).
 * @example
 *   <span style={{ ...commonStyles.textEllipsis, flex: 1, minWidth: 0 }}>
 *     {longName}
 *   </span>
 */
const textEllipsis: CSSProperties = {
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
};

/**
 * Monospace font family — uses the --rr-font-mono token (falls back to system
 * monospace).  Spread onto code snippets, IDs, hashes, or any value that must
 * be character-aligned.
 */
const fontMono: CSSProperties = {
	fontFamily: 'var(--rr-font-mono, monospace)',
};

/**
 * Uppercase section/field label — 11px bold, spaced, secondary colour.
 * Use for small metadata labels, column group headings, or form field labels
 * that should visually recede relative to their values.
 * Similar appearance to `tableHeader` but used inline rather than in a <th>.
 */
const labelUppercase: CSSProperties = {
	fontSize: 11,
	fontWeight: 600,
	textTransform: 'uppercase',
	letterSpacing: '0.5px',
	color: 'var(--rr-text-secondary)',
};

// =============================================================================
// OVERLAYS & MODALS
// =============================================================================
// Two backdrop variants exist:
//   overlay      — zIndex 10000, 50% black.  Use for toasts, sheets, and any
//                  UI that must sit above navigation and popups.
//   modalOverlay — zIndex 2000, 45% black.  Use for standard confirm/edit
//                  dialogs that sit above page content but below toasts.
//
// Pair either backdrop with `dialog` for the white box content container.
// For context menus that do NOT need a backdrop, use `popupMenu` directly.
// =============================================================================

/**
 * Full-screen high-priority backdrop (zIndex 10000) — dims the entire app.
 * Use for toasts, global loading sheets, and any overlay that must appear
 * above navigation bars and popup menus.
 * Pair with `dialog` for the contained box.
 */
const overlay: CSSProperties = {
	position: 'fixed',
	inset: 0,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	backgroundColor: 'rgba(0, 0, 0, 0.5)',
	zIndex: 10000,
};

/**
 * Standard modal backdrop (zIndex 2000) — dims the page behind a dialog.
 * Use for confirmation dialogs, edit dialogs, and form modals that sit above
 * the main content but do not need to cover navigation or popups.
 * Pair with `dialog` for the contained box.
 * Use `overlay` instead when the dialog must appear above everything.
 */
const modalOverlay: CSSProperties = {
	position: 'fixed',
	inset: 0,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	backgroundColor: 'rgba(0, 0, 0, 0.45)',
	zIndex: 2000,
};

/**
 * Dialog / modal content box — the rounded white box that sits on top of a
 * backdrop (`overlay` or `modalOverlay`).
 * Spread this and then add `width`, `padding`, and any per-dialog layout inline.
 * @example
 *   <div style={{ ...commonStyles.dialog, width: 480, padding: 24 }}>
 */
const dialog: CSSProperties = {
	background: 'var(--rr-bg-widget)',
	border: '1px solid var(--rr-border)',
	borderRadius: 10,
	boxShadow: '0 12px 40px var(--rr-shadow-widget)',
};

/**
 * Floating context / popup menu container — fixed-position card with shadow.
 * Use for right-click menus, "..." action menus, and dropdown panels.
 * Position top/left via state (e.g. mouse coordinates or element getBoundingClientRect).
 * Populate with `menuRow` items and `divider` separators.
 * Does NOT use a backdrop — dismiss by clicking outside (add a document listener).
 * zIndex 10000 so it floats above `modalOverlay` dialogs.
 */
const popupMenu: CSSProperties = {
	position: 'fixed',
	background: 'var(--rr-bg-paper)',
	border: '1px solid var(--rr-border)',
	borderRadius: 8,
	boxShadow: '0 4px 12px var(--rr-shadow-widget)',
	padding: 4,
	zIndex: 10000,
};

// =============================================================================
// NAVIGATION & MENUS
// =============================================================================
// Menu row styles for items inside a `popupMenu` or sidebar navigation list.
// On hover, set background to var(--rr-bg-list-hover) via a React state flag
// or a CSS class (inline styles cannot target :hover).
// Add `divider` between logical groups of rows.
// =============================================================================

/**
 * Single row inside a popup / context menu — flex row with icon + label gap.
 * Use for every clickable item in a `popupMenu`.
 * On hover: apply `{ background: 'var(--rr-bg-list-hover)' }` via a hover
 * state flag (inline styles have no :hover pseudo-class support).
 * For destructive items, override `color` to `var(--rr-color-error)` inline.
 */
const menuRow: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 8,
	padding: '5px 10px',
	borderRadius: 6,
	cursor: 'pointer',
	fontSize: 13,
	color: 'var(--rr-text-primary)',
	whiteSpace: 'nowrap',
};

// =============================================================================
// FORMS & INPUTS
// =============================================================================
// Single-line text input base.  Extend inline per usage.
// For textarea, also set resize:'vertical' or resize:'none' inline.
// =============================================================================

/**
 * Standard text input field — full-width, 13px, themed border and background.
 * Use as the base for <input> and <textarea> elements.
 * Override `width` inline when the input should not be full-width.
 * Add `marginBottom` inline between stacked fields inside a form.
 * For error state, override `borderColor` to `var(--rr-color-error)` inline.
 */
const inputField: CSSProperties = {
	width: '100%',
	padding: '7px 10px',
	fontSize: 13,
	border: '1px solid var(--rr-border-input)',
	borderRadius: 5,
	background: 'var(--rr-bg-input)',
	color: 'var(--rr-text-primary)',
	outline: 'none',
	boxSizing: 'border-box',
	fontFamily: 'inherit',
};

// =============================================================================
// LISTS & TREES
// =============================================================================
// Use listRow for file trees, sidebar nav lists, and any selectable row list.
// The active variant highlights the selected row with the brand list-active colour.
// On hover (non-active), set background to var(--rr-bg-list-hover) via state.
// =============================================================================

/**
 * Selectable list / tree row (function) — flex row with icon gap and active
 * highlight.  Pass `active=true` for the currently selected item.
 * On hover (when not active), apply `{ background: 'var(--rr-bg-list-hover)' }`
 * via a hover state flag.
 * Add left padding inline to simulate tree indentation levels:
 *   style={{ ...commonStyles.listRow(active), paddingLeft: 8 + depth * 16 }}
 * @param active - true when this row is the selected/active item.
 */
const listRow = (active: boolean): CSSProperties => ({
	display: 'flex',
	alignItems: 'center',
	gap: 6,
	padding: '4px 8px',
	borderRadius: 5,
	cursor: 'pointer',
	fontSize: 13,
	userSelect: 'none',
	background: active ? 'var(--rr-bg-list-active)' : 'transparent',
	color: active ? 'var(--rr-fg-list-active)' : 'var(--rr-text-primary)',
});

// =============================================================================
// CONTENT CONTAINERS
// =============================================================================
// Higher-level containers for structured content areas.
//
//  emptyState — full centred placeholder card when a list/view has no data.
//  iconBox    — square icon or avatar container; add dimensions inline.
//  badge      — compact inline status pill; add colour tokens inline per status.
// =============================================================================

/**
 * Empty state card — centred column layout on a surface-alt background.
 * Use when an entire view or list section has no data to show.
 * Typical children: icon/illustration → heading (<h3>) → description → CTA button.
 * For small panels with no rows, use the lighter `empty` text style instead.
 */
const emptyState: CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	justifyContent: 'center',
	textAlign: 'center',
	padding: '72px 24px',
	borderRadius: 12,
	background: 'var(--rr-bg-surface-alt)',
	border: '1px solid var(--rr-border)',
};

/**
 * Icon box / avatar container — centred flex box for icons, SVGs, or text
 * initials.  Provides the border-radius and background; add width and height
 * inline per usage.
 * @example
 *   <div style={{ ...commonStyles.iconBox, width: 40, height: 40 }}>
 *     <MyIcon />
 *   </div>
 * Override borderRadius inline for circular avatars (borderRadius:'50%').
 */
const iconBox: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	borderRadius: 10,
	background: 'var(--rr-bg-widget)',
};

/**
 * Status / label badge — compact pill for short status strings or tags.
 * Provides the pill shape and typography; set backgroundColor and color inline
 * per status variant (e.g. success green, error red, info blue).
 * Pair with `indicatorSuccess` / `indicatorError` etc. inside the badge for a
 * dot + label combination.
 * @example
 *   <span style={{ ...commonStyles.badge, backgroundColor:'var(--rr-color-success-muted)', color:'var(--rr-color-success)' }}>
 *     Active
 *   </span>
 */
const badge: CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: 4,
	padding: '2px 8px',
	fontSize: 11,
	fontWeight: 600,
	borderRadius: 10,
	letterSpacing: '0.3px',
};

// =============================================================================
// EXPORT
// =============================================================================

export const commonStyles = {
	// Cards — use together: card → cardHeader + cardBody, or cardFlat standalone
	card,
	cardHeader,
	cardBody,
	cardFlat,

	// Sections — use together: section → sectionHeader → sectionHeaderLabel
	section,
	sectionHeader,
	sectionHeaderLabel,

	// Buttons — primary/secondary/danger + buttonDisabled modifier
	buttonPrimary,
	buttonDanger,
	buttonDangerOutline,
	buttonSecondary,
	buttonDisabled,
	// Toggle buttons — toggleGroup wraps toggleButton(active) items
	toggleButton,
	toggleGroup,

	// Layout — columnFill → headerBar + (tabContent | viewPadding); splitHeader inside content
	splitHeader,
	tabContent,
	viewPadding, // @deprecated: use tabContent
	columnFill,
	headerBar,
	divider,

	// Text helpers
	empty,
	textMuted,
	textEllipsis,
	fontMono,
	labelUppercase,

	// Overlays & modals — (overlay | modalOverlay) → dialog; popupMenu standalone
	overlay,
	modalOverlay,
	dialog,
	popupMenu,

	// Navigation & menus — popupMenu → menuRow items + divider separators
	menuRow,

	// Forms & inputs
	inputField,

	// Lists & trees — listRow(active) for each row
	listRow,

	// Content containers
	emptyState,
	iconBox,
	badge,

	// Tables — tableHeader (th) + tableCell (td) inside a plain <table>
	tableHeader,
	tableCell,

	// Status indicators — use named variants directly (Success/Info/Warning/Error/Muted)
	indicatorBase,
	indicatorSuccess,
	indicatorInfo,
	indicatorWarning,
	indicatorError,
	indicatorMuted,
};
