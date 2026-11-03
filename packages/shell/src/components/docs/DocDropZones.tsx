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
// DOC DROP ZONES — drag-a-tab-onto-a-pane split targets (VS Code gesture)
// =============================================================================
//
// Wraps one leaf pane of the document split layout and turns its body into a
// drop target for dragged tabs. Hovering a dragged tab over the pane shows a
// translucent highlight covering the half of the pane the editor would occupy
// (or the whole pane for a center drop); dropping performs the action:
//
//   center       — move the editor into this group
//   left/right   — split horizontally, new group before/after, move editor in
//   top/bottom   — split vertically, new group before/after, move editor in
//
// Drag events BUBBLE up from the pane content to the wrapper, so no
// full-surface interceptor is needed and the pane stays fully interactive
// when no drag is in flight. The highlight itself is pointer-events: none.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from '../../themes/styles';
import { EDITOR_DND_MIME, getEditorDrag } from './Documents';
import type { DocumentsLike, SplitOrientation, SplitPosition } from './Documents';

// =============================================================================
// TYPES
// =============================================================================

/** The five drop regions of a pane. */
type DropRegion = 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Props for the DocDropZones component.
 */
export interface DocDropZonesProps {
	/** The Documents instance to read drag state from and dispatch actions to. */
	docs: DocumentsLike;
	/** The editor group rendered inside this pane. */
	groupId: string;
	/** The pane content (the app's renderPane output). */
	children: React.ReactNode;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Fraction of the pane's width/height that counts as an edge zone — pointer
 * inside the outer 20% band targets a split, anywhere else targets a move
 * into the group (VS Code uses the same proportion).
 */
const EDGE_FRACTION = 0.2;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// The wrapper replaces DocSplitLayout's bare leaf div: same fill behavior,
	// plus relative positioning so the highlight can overlay the content.
	wrapper: {
		...commonStyles.columnFill,
		minWidth: 0,
		overflow: 'hidden',
		position: 'relative',
	} as CSSProperties,

	// Translucent brand-tinted highlight covering the region the dropped
	// editor would occupy. pointer-events: none so it never swallows the
	// dragover events that position it.
	highlight: (region: DropRegion): CSSProperties => ({
		position: 'absolute',
		top: region === 'bottom' ? '50%' : 0,
		bottom: region === 'top' ? '50%' : 0,
		left: region === 'right' ? '50%' : 0,
		right: region === 'left' ? '50%' : 0,
		backgroundColor: 'var(--rr-brand)',
		opacity: 0.15,
		border: '1px solid var(--rr-brand)',
		pointerEvents: 'none',
		zIndex: 10,
	}),
};

// =============================================================================
// REGION GEOMETRY
// =============================================================================

/**
 * Maps a pointer position inside a rect to a drop region. The outer
 * EDGE_FRACTION band on each side targets that edge (nearest edge wins in
 * the corners); everything else is a center drop.
 *
 * @param rect    - The pane's bounding rect.
 * @param clientX - Pointer x in viewport coordinates.
 * @param clientY - Pointer y in viewport coordinates.
 * @returns The targeted drop region.
 */
function regionFromPoint(rect: DOMRect, clientX: number, clientY: number): DropRegion {
	// Normalise the pointer to 0..1 within the pane
	const x = (clientX - rect.left) / Math.max(rect.width, 1);
	const y = (clientY - rect.top) / Math.max(rect.height, 1);

	// Distance to each edge as a fraction; the nearest edge within the band wins
	const edges: Array<[DropRegion, number]> = [
		['left', x],
		['right', 1 - x],
		['top', y],
		['bottom', 1 - y],
	];
	edges.sort((a, b) => a[1] - b[1]);
	const [region, distance] = edges[0]!;
	return distance < EDGE_FRACTION ? region : 'center';
}

/** Maps an edge region to the split orientation it produces. */
const REGION_ORIENTATION: Record<Exclude<DropRegion, 'center'>, SplitOrientation> = {
	left: 'horizontal',
	right: 'horizontal',
	top: 'vertical',
	bottom: 'vertical',
};

/** Maps an edge region to where the new group lands relative to this one. */
const REGION_POSITION: Record<Exclude<DropRegion, 'center'>, SplitPosition> = {
	left: 'before',
	right: 'after',
	top: 'before',
	bottom: 'after',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Drop-zone wrapper for one leaf pane of the document split layout.
 *
 * Shows the region highlight while a tab drag hovers the pane and performs
 * the move/split on drop. Gestures that would be no-ops are suppressed during
 * hover (no highlight, drop not allowed): a center drop onto the editor's own
 * group, and an edge split dragged from a group that only has that one tab
 * (it would collapse right back, yielding the original layout).
 *
 * @param props.docs     - The Documents instance.
 * @param props.groupId  - The group rendered in this pane.
 * @param props.children - The pane content.
 */
const DocDropZones: React.FC<DocDropZonesProps> = ({ docs, groupId, children }) => {
	const [region, setRegion] = useState<DropRegion | null>(null);

	/**
	 * Checks whether dropping the in-flight drag on a region would change
	 * anything. Unknown sessions (no dragstart seen) are allowed through and
	 * re-validated at drop time.
	 *
	 * @param candidate - The region under the pointer.
	 * @returns True if the drop would have an effect.
	 */
	const isUsefulDrop = useCallback((candidate: DropRegion): boolean => {
		const session = getEditorDrag(docs);
		if (!session) return true;
		if (candidate === 'center') {
			// Moving an editor into its own group is a no-op (no reorder support)
			return session.sourceGroupId !== groupId;
		}
		if (session.sourceGroupId === groupId) {
			// Edge-splitting a group's only tab out of itself recreates the
			// same layout after the source collapses — suppress it
			const group = docs.getState().groups[groupId];
			return (group?.editorIds.length ?? 0) > 1;
		}
		return true;
	}, [docs, groupId]);

	/**
	 * Tracks the hovered region while a tab drag is over the pane. Only
	 * accepts the drag (preventDefault) for gestures that would change state.
	 *
	 * @param e - The drag event.
	 */
	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (!e.dataTransfer.types.includes(EDITOR_DND_MIME)) return;
		const candidate = regionFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
		if (!isUsefulDrop(candidate)) {
			setRegion(null);
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setRegion((prev) => (prev === candidate ? prev : candidate));
	}, [isUsefulDrop]);

	/**
	 * Clears the highlight when the drag truly leaves the pane. dragleave also
	 * fires when crossing into child elements — those are ignored, EXCEPT the
	 * tab bar: it stops dragover propagation and handles drops itself, so
	 * entering it must drop this pane's highlight.
	 *
	 * @param e - The drag event.
	 */
	const handleDragLeave = useCallback((e: React.DragEvent) => {
		const related = e.relatedTarget as Node | null;
		const intoBar = related instanceof Element && related.closest('[data-rr-editor-droptarget]') !== null;
		if (!intoBar && e.currentTarget.contains(related)) return;
		setRegion(null);
	}, []);

	// Safety net for highlight cleanup: when the drop lands on another target
	// (tab bar, another pane) or the drag is cancelled with Escape, this pane
	// gets no drop/dragleave of its own — dragend on the source always fires
	// and bubbles to window, so clear there.
	useEffect(() => {
		if (region === null) return;
		const clear = (): void => setRegion(null);
		window.addEventListener('dragend', clear);
		return () => window.removeEventListener('dragend', clear);
	}, [region]);

	/**
	 * Performs the drop: center moves the editor into this group, an edge
	 * splits this group in that direction and moves the editor into the new
	 * group. The emptied source group auto-collapses inside moveEditor.
	 *
	 * @param e - The drop event.
	 */
	const handleDrop = useCallback((e: React.DragEvent) => {
		if (!e.dataTransfer.types.includes(EDITOR_DND_MIME)) return;
		e.preventDefault();
		// Stop the event here so an enclosing drop target (e.g. a tab bar
		// above a nested layout) never double-handles the same gesture
		e.stopPropagation();
		setRegion(null);

		// Resolve the payload — transfer data first, drag session as fallback
		let editorId: string | undefined;
		let sourceGroupId: string | undefined;
		try {
			const data = JSON.parse(e.dataTransfer.getData(EDITOR_DND_MIME));
			editorId = data.editorId;
			sourceGroupId = data.sourceGroupId;
		} catch { /* ignore malformed data */ }
		if (!editorId) {
			const session = getEditorDrag(docs);
			if (!session) return;
			editorId = session.editorId;
			sourceGroupId = session.sourceGroupId;
		}

		// A tab dragged from a DIFFERENT Documents instance (another app's
		// layout in the same window) must not act here — the editor id means
		// nothing in this model, and an edge drop would manufacture an empty
		// split before moveEditor no-ops
		if (!docs.getState().editors[editorId]) return;

		// Re-derive the region at the drop point and re-validate the gesture
		const target = regionFromPoint(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
		if (!isUsefulDrop(target)) return;

		if (target === 'center') {
			// Plain move into this group
			if (sourceGroupId !== groupId) docs.moveEditor(editorId, groupId);
			docs.setActiveGroup(groupId);
			return;
		}

		// Edge-splitting a group's only tab out of itself recreates the same
		// layout after the source collapses. isUsefulDrop suppresses this via
		// the drag SESSION — re-check with the RESOLVED source group, because
		// a drag that never called beginEditorDrag (no session) still carries
		// transfer data and would otherwise manufacture an empty split.
		if (sourceGroupId === groupId && (docs.getState().groups[groupId]?.editorIds.length ?? 0) <= 1) return;

		// Edge drop — split this group, then move the editor into the new pane
		const newGroupId = docs.splitGroup(groupId, REGION_ORIENTATION[target], REGION_POSITION[target]);
		docs.moveEditor(editorId, newGroupId);
	}, [docs, groupId, isUsefulDrop]);

	return (
		<div
			style={styles.wrapper}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{children}
			{/* Region highlight — only present while a valid drag hovers the pane */}
			{region !== null && <div style={styles.highlight(region)} />}
		</div>
	);
};

export default DocDropZones;
