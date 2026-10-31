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
// DOC TABS — tab bar UI for an editor group
// =============================================================================
//
// Renders a horizontal tab strip for the editors in a given EditorGroup.
// Reads from the DocumentsProvider context to display tab labels, dirty
// indicators, and close buttons.
// =============================================================================

import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { EDITOR_DND_MIME, beginEditorDrag, endEditorDrag } from './Documents';
import type { DocumentsLike, SplitOrientation } from './Documents';

// =============================================================================
// STYLES
// =============================================================================

/** MIME type key for drag-and-drop editor transfers (shared with DocDropZones). */
const DND_MIME = EDITOR_DND_MIME;

/** Class names for the bar and its scrollable tab region (hover-scrollbar CSS). */
const BAR_CLASS = 'rr-doctabs-bar';
const SCROLL_CLASS = 'rr-doctabs-scroll';
const SCROLL_STYLE_ID = 'rr-doctabs-scroll-style';

/**
 * Injects the hover-scrollbar rules exactly once.
 *
 * Inline styles cannot express the VS Code behaviour where the tab strip's
 * horizontal scrollbar is invisible until the bar is hovered: the thumb colour
 * must flip on an ancestor's `:hover`. The thin scrollbar is always declared
 * (so overflowing strips reserve its lane and nothing jumps on hover) with a
 * transparent thumb that only takes the token colour while the bar is hovered.
 */
function ensureScrollStyle(): void {
	// Skip when there is no document (non-browser environments).
	if (typeof document === 'undefined') return;
	// Already injected — nothing to do.
	if (document.getElementById(SCROLL_STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = SCROLL_STYLE_ID;
	el.textContent = [
		`.${SCROLL_CLASS} { scrollbar-width: thin; scrollbar-color: transparent transparent; }`,
		`.${BAR_CLASS}:hover .${SCROLL_CLASS} { scrollbar-color: var(--rr-bg-scrollbar-thumb, rgba(121, 121, 121, 0.4)) transparent; }`,
	].join('\n');
	document.head.appendChild(el);
}

// Inject once at module load (safe no-op outside the DOM) so the first paint
// already has the hover rules — a mount effect would run one frame too late.
ensureScrollStyle();

/** Upper-corner radius of the active tab AND the radius of the concave
    connectors flaring its bottom edge into the strip. */
const TAB_RADIUS = 8;

const styles = {
	// The strip: a full-width shaded band the tabs sit on, VS Code's
	// editorGroupHeader.tabsBackground. The --rr-doctabs-* tokens are mapped
	// to the real --vscode-tab-* variables in the VS Code host; everywhere
	// else the fallbacks reuse the stock semantic tokens.
	bar: (_isActiveGroup: boolean, isDragOver: boolean): CSSProperties => ({
		display: 'flex',
		height: 36,
		flexShrink: 0,
		// NO bottom rule: the strip and the editor below separate by fill
		// alone, exactly like VS Code's tab bar. The drop-target cue is an
		// inset shadow (a border would change the bar's inner height and
		// jiggle the tabs mid-drag).
		boxShadow: isDragOver ? 'inset 0 2px 0 var(--rr-brand)' : 'none',
		backgroundColor: 'var(--rr-doctabs-bg, var(--rr-bg-widget))',
		overflow: 'hidden',
		alignItems: 'stretch',
	}),
	// The scrollable tab region — the toolbar buttons sit OUTSIDE it, pinned to
	// the bar's right edge, so only the tabs pan. Overflow handling lives in
	// the injected SCROLL_CLASS rules (thumb visible only while the bar is
	// hovered, VS Code-style).
	tabsScroll: {
		display: 'flex',
		alignItems: 'stretch',
		flex: 1,
		minWidth: 0,
		overflowX: 'auto',
		overflowY: 'hidden',
	} as CSSProperties,
	// Modern VS Code tab anatomy: the active tab is a browser-style tab —
	// editor-background fill, ROUNDED upper corners, and concave connectors
	// flaring its bottom edge into the strip (the corner pieces below).
	// Inactive tabs have NO fill of their own — the strip shows through —
	// and a neutral hover overlay that must never read as the active fill.
	// 1px separators divide them, dropped next to the active tab where VS
	// Code hides them. Weight stays normal — VS Code never bolds the label.
	tab: (isActive: boolean, _isActiveGroup: boolean, isHovered: boolean, isDragging: boolean, hideSeparator: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 12px',
		height: '100%',
		cursor: 'grab',
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
		color: isActive
			? 'var(--rr-doctabs-fg-active, var(--rr-text-primary))'
			: 'var(--rr-doctabs-fg-inactive, var(--rr-text-secondary))',
		backgroundColor: isActive
			? 'var(--rr-doctabs-tab-active-bg, var(--rr-bg-default))'
			: isHovered
				? 'var(--rr-doctabs-tab-hover-bg, var(--rr-bg-widget-hover))'
				: 'transparent',
		borderRadius: isActive || isHovered ? `${TAB_RADIUS}px ${TAB_RADIUS}px 0 0` : 0,
		borderRight: isActive || hideSeparator ? '1px solid transparent' : '1px solid var(--rr-doctabs-border, var(--rr-border))',
		whiteSpace: 'nowrap',
		position: 'relative',
		// The active tab paints ABOVE its neighbours so the corner connectors
		// can overhang them.
		zIndex: isActive ? 1 : undefined,
		userSelect: 'none',
		opacity: isDragging ? 0.4 : 1,
	}),
	// Concave bottom connectors: an r×r piece outside each bottom corner of
	// the active tab, filled with the tab colour except a quarter-circle of
	// it carved away — the browser-tab flare joining the tab to the strip
	// rule. The half-pixel stop softens the curve's edge (anti-aliasing).
	tabCorner: (side: 'left' | 'right'): CSSProperties => ({
		position: 'absolute',
		bottom: 0,
		[side]: -TAB_RADIUS,
		width: TAB_RADIUS,
		height: TAB_RADIUS,
		background: `radial-gradient(circle at ${side === 'left' ? '0 0' : '100% 0'}, transparent ${TAB_RADIUS}px, var(--rr-doctabs-tab-active-bg, var(--rr-bg-default)) ${TAB_RADIUS + 0.5}px)`,
		pointerEvents: 'none',
	}),
	// Neutral on purpose: "unsaved" must never share a color with the
	// warning-diagnostics chips (indicator-semantics decision 2026-08-07 —
	// VS Code's own dirty marker is the plain tab foreground for the same
	// reason).
	dirtyDot: {
		width: 6,
		height: 6,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-text-primary)',
		flexShrink: 0,
	} as CSSProperties,
	// 24px box + 22px glyph: the 36px strip still fits it, and anything
	// smaller proved too small to see or hit (sized up twice by request).
	closeBtn: (visible: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 24,
		height: 24,
		borderRadius: 4,
		border: 'none',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		fontSize: 22,
		lineHeight: 1,
		opacity: visible ? 1 : 0,
		transition: 'opacity 100ms',
		flexShrink: 0,
	}),
	empty: {
		display: 'flex',
		alignItems: 'center',
		padding: '0 12px',
		fontSize: 12,
		color: 'var(--rr-text-tertiary, #888)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	toolbarBtn: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 28,
		height: '100%',
		border: 'none',
		background: 'transparent',
		color: 'var(--rr-text-tertiary)',
		cursor: 'pointer',
		fontSize: 14,
		flexShrink: 0,
		position: 'relative',
	} as CSSProperties,
	contextMenu: (top: number, left: number): CSSProperties => ({
		position: 'fixed',
		top,
		left,
		zIndex: 1000,
		minWidth: 140,
		padding: '4px 0',
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 12,
	}),
	menuItem: (hovered: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 12px',
		cursor: 'pointer',
		color: 'var(--rr-text-primary)',
		backgroundColor: hovered ? 'var(--rr-bg-surface-alt)' : 'transparent',
	}),
};

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for the DocTabs component.
 */
export interface DocTabsProps {
	/**
	 * The Documents instance to read state from and dispatch actions to.
	 *
	 * The policy-aware verbs are OPTIONAL in this type on purpose: the
	 * frozen shell contract pins the Documents shape apps were built
	 * against, so requiring members added later would reject a perfectly
	 * good instance from a v5-era app. Absence is feature-detected below
	 * and falls back to the unconditional close.
	 */
	docs: DocumentsLike;
	/** The editor group whose tabs should be rendered. */
	groupId: string;
	/** Whether this group is the currently focused group. */
	isActive?: boolean;
	/** Whether this group can be closed (false when it's the only group). */
	canClose?: boolean;
	/** Optional callback when a tab's close button triggers a dirty document prompt. */
	onDirtyClose?: (editorId: string, documentUri: string) => void;
	/** Optional callback to split this group in a given direction. */
	onSplit?: (groupId: string, orientation: SplitOrientation) => void;
	/** Optional callback to close (remove) this entire group. */
	onCloseGroup?: (groupId: string) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Tab bar UI for a single editor group.
 *
 * Renders one tab per editor in the group. Tabs show the editor label, a
 * dirty indicator dot for unsaved documents, and a close button on hover.
 *
 * @param props.groupId    - ID of the EditorGroup to render tabs for.
 * @param props.onDirtyClose - Optional callback for dirty-close confirmation.
 */
const DocTabs: React.FC<DocTabsProps> = ({ docs, groupId, isActive = false, canClose = false, onDirtyClose, onSplit, onCloseGroup }) => {
	const state = docs.useStore();
	const group = state.groups[groupId];
	const [hoveredTab, setHoveredTab] = useState<string | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [splitMenuOpen, setSplitMenuOpen] = useState(false);
	const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);
	const splitBtnRef = useRef<HTMLButtonElement>(null);

	// --- Tab click handler ----------------------------------------------------

	/**
	 * Handles clicking a tab — activates the editor and focuses the group.
	 *
	 * @param index - The index of the editor in the group's editorIds array.
	 */
	const handleTabClick = useCallback((index: number) => {
		docs.setActiveEditor(groupId, index);
		docs.setActiveGroup(groupId);
	}, [docs, groupId]);

	// --- Tab close handler ----------------------------------------------------

	/**
	 * Handles the close button click on a tab.
	 *
	 * An app that passes `onDirtyClose` owns the decision for a dirty
	 * document (the pre-existing contract). Otherwise the close goes
	 * through requestCloseEditor, which applies the Documents instance's
	 * dirty-close policy — the shell's Save/Discard/Cancel dialog by
	 * default, and NEVER a silent discard.
	 *
	 * Note it asks only when this is the LAST view of the document; a split
	 * view closes without ceremony because nothing is lost.
	 *
	 * @param e        - Mouse event (stopped to prevent tab activation).
	 * @param editorId - The editor to close.
	 */
	const handleClose = useCallback((e: React.MouseEvent, editorId: string) => {
		e.stopPropagation();
		const editor = state.editors[editorId];
		if (!editor) return;
		const doc = state.documents[editor.documentUri];
		// If dirty and callback provided, delegate for confirmation
		if (doc?.dirty && onDirtyClose) {
			onDirtyClose(editorId, editor.documentUri);
			return;
		}
		if (docs.requestCloseEditor) {
			void docs.requestCloseEditor(editorId);
			return;
		}
		docs.closeEditor(editorId);
	}, [docs, state, onDirtyClose]);

	// --- Split handler --------------------------------------------------------

	/**
	 * Handles a split menu item click — calls onSplit and closes the menu.
	 *
	 * @param orientation - The split direction to apply.
	 */
	const handleSplit = useCallback((orientation: SplitOrientation) => {
		setSplitMenuOpen(false);
		onSplit?.(groupId, orientation);
	}, [onSplit, groupId]);

	// --- Drag-and-drop handlers -----------------------------------------------

	/**
	 * Starts a drag operation, storing the editor ID and source group in transfer data.
	 *
	 * @param e        - The drag event.
	 * @param editorId - The editor being dragged.
	 */
	const handleDragStart = useCallback((e: React.DragEvent, editorId: string) => {
		e.dataTransfer.setData(DND_MIME, JSON.stringify({ editorId, sourceGroupId: groupId }));
		e.dataTransfer.effectAllowed = 'move';
		// Publish the drag session so pane drop zones can validate the gesture
		// during hover (the transfer payload is unreadable until drop)
		beginEditorDrag(docs, editorId, groupId);
		setDraggingId(editorId);
	}, [docs, groupId]);

	/**
	 * Clears the dragging visual state and the shared drag session when drag ends.
	 */
	const handleDragEnd = useCallback(() => {
		endEditorDrag(docs);
		setDraggingId(null);
	}, [docs]);

	/**
	 * Allows the tab bar to accept drops by preventing the default.
	 *
	 * @param e - The drag event.
	 */
	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (e.dataTransfer.types.includes(DND_MIME)) {
			e.preventDefault();
			// The bar owns the gesture while hovered — don't let the enclosing
			// DocDropZones pane wrapper show an edge-split highlight for it
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
			setIsDragOver(true);
		}
	}, []);

	/**
	 * Clears the drag-over visual indicator.
	 */
	const handleDragLeave = useCallback(() => {
		setIsDragOver(false);
	}, []);

	/**
	 * Handles a tab drop — moves the editor to this group.
	 *
	 * @param e - The drop event.
	 */
	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		// Stop here so the enclosing DocDropZones pane wrapper never
		// double-handles the same drop as an edge split
		if (e.dataTransfer.types.includes(DND_MIME)) e.stopPropagation();
		setIsDragOver(false);
		try {
			const data = JSON.parse(e.dataTransfer.getData(DND_MIME));
			if (data.editorId && data.sourceGroupId !== groupId) {
				docs.moveEditor(data.editorId, groupId);
				docs.setActiveGroup(groupId);
			}
		} catch { /* ignore malformed data */ }
	}, [docs, groupId]);

	// --- Toolbar buttons (right edge) ----------------------------------------

	/**
	 * Renders the toolbar buttons at the right edge of the tab bar:
	 * split button and optional close-group button.
	 */
	const renderToolbar = () => (
		<>
			{onSplit && (
				<SplitButton
					btnRef={splitBtnRef}
					open={splitMenuOpen}
					onToggle={() => setSplitMenuOpen((v) => !v)}
					onClose={() => setSplitMenuOpen(false)}
					onSplit={handleSplit}
					hoveredItem={hoveredMenuItem}
					onHoverItem={setHoveredMenuItem}
				/>
			)}
			{canClose && onCloseGroup && (
				<button
					style={styles.toolbarBtn}
					onClick={() => onCloseGroup(groupId)}
					title="Close group"
				>
					×
				</button>
			)}
		</>
	);

	// --- Render --------------------------------------------------------------

	if (!group) return null;

	if (group.editorIds.length === 0) {
		return (
			<div
				className={BAR_CLASS}
				style={styles.bar(isActive, isDragOver)}
				data-rr-editor-droptarget="true"
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<div className={SCROLL_CLASS} style={styles.tabsScroll}>
					<div style={styles.empty}>No open editors</div>
				</div>
				{renderToolbar()}
			</div>
		);
	}

	return (
		<div
			className={BAR_CLASS}
			style={styles.bar(isActive, isDragOver)}
			data-rr-editor-droptarget="true"
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div
				className={SCROLL_CLASS}
				style={styles.tabsScroll}
				// A plain vertical wheel pans the strip horizontally (VS Code
				// behaviour) — trackpad horizontal swipes already scroll natively.
				onWheel={(e) => {
					if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
				}}
			>
			{group.editorIds.map((editorId, index) => {
				const editor = state.editors[editorId];
				if (!editor) return null;
				const doc = state.documents[editor.documentUri];
				const isActiveTab = index === group.activeEditorIndex;
				const isHovered = hoveredTab === editorId;
				// VS Code hides the separator adjacent to the active tab (its
				// connector curve takes that spot).
				const precedesActive = index + 1 === group.activeEditorIndex;

				return (
					<div
						key={editorId}
						draggable
						style={styles.tab(isActiveTab, isActive, isHovered, draggingId === editorId, precedesActive)}
						onClick={() => handleTabClick(index)}
						onMouseEnter={() => setHoveredTab(editorId)}
						onMouseLeave={() => setHoveredTab(null)}
						onDragStart={(e) => handleDragStart(e, editorId)}
						onDragEnd={handleDragEnd}
					>
						{isActiveTab && <span style={styles.tabCorner('left')} />}
						{isActiveTab && <span style={styles.tabCorner('right')} />}
						{doc?.dirty && <div style={styles.dirtyDot} />}
						<span>{editor.label}</span>
						<button
							style={styles.closeBtn(isActiveTab || isHovered)}
							onClick={(e) => handleClose(e, editorId)}
						>
							×
						</button>
					</div>
				);
			})}
			</div>
			{renderToolbar()}
		</div>
	);
};

// =============================================================================
// SPLIT BUTTON — dropdown with "Split Right" / "Split Down"
// =============================================================================

/**
 * Props for the internal SplitButton component.
 */
interface SplitButtonProps {
	/** Ref to the button element for positioning. */
	btnRef: React.RefObject<HTMLButtonElement>;
	/** Whether the dropdown menu is currently open. */
	open: boolean;
	/** Toggle the dropdown open/closed. */
	onToggle: () => void;
	/** Close the dropdown. */
	onClose: () => void;
	/** Callback when a split direction is selected. */
	onSplit: (orientation: SplitOrientation) => void;
	/** Currently hovered menu item key. */
	hoveredItem: string | null;
	/** Setter for hovered menu item. */
	onHoverItem: (key: string | null) => void;
}

/**
 * Small split button at the right edge of the tab bar.
 * Shows a dropdown with "Split Right" and "Split Down" options.
 *
 * @param props - SplitButton props.
 */
const SplitButton: React.FC<SplitButtonProps> = ({ btnRef, open, onToggle, onClose, onSplit, hoveredItem, onHoverItem }) => {
	/**
	 * Handles blur on the button — closes the menu after a short delay
	 * to allow click events on menu items to fire first.
	 */
	const handleBlur = useCallback(() => {
		setTimeout(() => onClose(), 150);
	}, [onClose]);

	// Compute fixed position from button bounding rect
	const rect = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null;

	return (
		<button
			ref={btnRef}
			style={styles.toolbarBtn}
			onClick={onToggle}
			onBlur={handleBlur}
			title="Split editor"
		>
			{/* Simple split icon using Unicode box drawing */}
			&#x2503;
			{open && rect && createPortal(
				<div style={styles.contextMenu(rect.bottom, rect.right - 140)}>
					<div
						style={styles.menuItem(hoveredItem === 'h')}
						onMouseEnter={() => onHoverItem('h')}
						onMouseLeave={() => onHoverItem(null)}
						onMouseDown={(e) => { e.preventDefault(); onSplit('horizontal'); }}
					>
						&#x25EB; Split Right
					</div>
					<div
						style={styles.menuItem(hoveredItem === 'v')}
						onMouseEnter={() => onHoverItem('v')}
						onMouseLeave={() => onHoverItem(null)}
						onMouseDown={(e) => { e.preventDefault(); onSplit('vertical'); }}
					>
						&#x2B12; Split Down
					</div>
				</div>,
				document.body,
			)}
		</button>
	);
};

export default DocTabs;
