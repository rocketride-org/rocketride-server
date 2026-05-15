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
import type { Documents, SplitOrientation } from './Documents';

// =============================================================================
// STYLES
// =============================================================================

/** MIME type key for drag-and-drop editor transfers. */
const DND_MIME = 'application/x-rr-editor';

const styles = {
	bar: (isActiveGroup: boolean, isDragOver: boolean): CSSProperties => ({
		display: 'flex',
		height: 36,
		flexShrink: 0,
		borderBottom: '1px solid var(--rr-border)',
		borderTop: isDragOver ? '2px solid var(--rr-brand)' : 'none',
		paddingTop: isDragOver ? 0 : 3,
		backgroundColor: 'var(--rr-bg-paper)',
		overflow: 'hidden',
		alignItems: 'stretch',
	}),
	tab: (isActive: boolean, isActiveGroup: boolean, isHovered: boolean, isDragging: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '0 12px',
		height: '100%',
		cursor: 'grab',
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
		fontWeight: isActive ? 600 : 400,
		color: isActive ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		backgroundColor: isActive
			? 'var(--rr-bg-default)'
			: isHovered ? 'var(--rr-bg-surface-alt)' : 'transparent',
		borderRight: '1px solid var(--rr-border)',
		borderBottom: isActive && isActiveGroup ? '2px solid var(--rr-brand)' : '2px solid transparent',
		whiteSpace: 'nowrap',
		position: 'relative',
		userSelect: 'none',
		opacity: isDragging ? 0.4 : 1,
	}),
	dirtyDot: {
		width: 6,
		height: 6,
		borderRadius: '50%',
		backgroundColor: 'var(--rr-color-warning, #f59e0b)',
		flexShrink: 0,
	} as CSSProperties,
	closeBtn: (visible: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 16,
		height: 16,
		borderRadius: 3,
		border: 'none',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
		fontSize: 12,
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
	spacer: {
		flex: 1,
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
	/** The Documents instance to read state from and dispatch actions to. */
	docs: Documents;
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
	 * If the document is dirty and an onDirtyClose callback is provided,
	 * delegates to the callback. Otherwise closes the editor directly.
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
		setDraggingId(editorId);
	}, [groupId]);

	/**
	 * Clears the dragging visual state when drag ends.
	 */
	const handleDragEnd = useCallback(() => {
		setDraggingId(null);
	}, []);

	/**
	 * Allows the tab bar to accept drops by preventing the default.
	 *
	 * @param e - The drag event.
	 */
	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (e.dataTransfer.types.includes(DND_MIME)) {
			e.preventDefault();
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
			<div style={styles.spacer} />
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
				style={styles.bar(isActive, isDragOver)}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<div style={styles.empty}>No open editors</div>
				{renderToolbar()}
			</div>
		);
	}

	return (
		<div
			style={styles.bar(isActive, isDragOver)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{group.editorIds.map((editorId, index) => {
				const editor = state.editors[editorId];
				if (!editor) return null;
				const doc = state.documents[editor.documentUri];
				const isActiveTab = index === group.activeEditorIndex;
				const isHovered = hoveredTab === editorId;

				return (
					<div
						key={editorId}
						draggable
						style={styles.tab(isActiveTab, isActive, isHovered, draggingId === editorId)}
						onClick={() => handleTabClick(index)}
						onMouseEnter={() => setHoveredTab(editorId)}
						onMouseLeave={() => setHoveredTab(null)}
						onDragStart={(e) => handleDragStart(e, editorId)}
						onDragEnd={handleDragEnd}
					>
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
	btnRef: React.RefObject<HTMLButtonElement | null>;
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
