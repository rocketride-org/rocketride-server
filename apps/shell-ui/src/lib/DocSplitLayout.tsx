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
// DOC SPLIT LAYOUT — recursive split layout renderer using allotment
// =============================================================================
//
// Renders a Documents layout tree as nested resizable split panes.
// Leaf nodes call the app-provided renderPane callback; split nodes
// render an <Allotment> container with two children.
// =============================================================================

import React, { useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import type { Documents, LayoutNode, LayoutSplit } from './Documents';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		...commonStyles.columnFill,
		flex: 1,
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,
	leaf: {
		...commonStyles.columnFill,
		minWidth: 0,
		overflow: 'hidden',
	} as CSSProperties,
};

/** Minimum pane size in pixels to prevent panes from being dragged to zero. */
const MIN_PANE_SIZE = 200;

/** Debounce interval for persisting allotment resize sizes. */
const SIZE_DEBOUNCE_MS = 200;

// =============================================================================
// PROPS
// =============================================================================

/**
 * Props for the DocSplitLayout component.
 */
export interface DocSplitLayoutProps {
	/** The Documents instance to read layout state from. */
	docs: Documents;
	/** Render function for each leaf pane — receives groupId, returns JSX. */
	renderPane: (groupId: string) => React.ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Recursive split layout renderer.
 *
 * Reads the layout tree from the Documents instance and renders nested
 * allotment split panes.  Each leaf calls the app's renderPane callback.
 *
 * @param props.docs       - The Documents instance.
 * @param props.renderPane - Callback that renders the content of a leaf pane.
 */
const DocSplitLayout: React.FC<DocSplitLayoutProps> = ({ docs, renderPane }) => {
	const state = docs.useStore();
	return (
		<div style={styles.root}>
			<LayoutNodeRenderer node={state.rootNode} docs={docs} renderPane={renderPane} />
		</div>
	);
};

// =============================================================================
// INTERNAL — RECURSIVE NODE RENDERER
// =============================================================================

/**
 * Props for the internal recursive node renderer.
 */
interface LayoutNodeRendererProps {
	/** The layout tree node to render. */
	node: LayoutNode;
	/** The Documents instance (for persisting resize sizes). */
	docs: Documents;
	/** Render function for leaf panes. */
	renderPane: (groupId: string) => React.ReactNode;
}

/**
 * Renders a single layout node.  Leaf nodes delegate to renderPane;
 * split nodes render an Allotment container with two child panes.
 *
 * @param props.node       - The current layout tree node.
 * @param props.docs       - The Documents instance.
 * @param props.renderPane - Callback that renders leaf pane content.
 */
const LayoutNodeRenderer: React.FC<LayoutNodeRendererProps> = ({ node, docs, renderPane }) => {
	if (node.type === 'leaf') {
		return <div style={styles.leaf}>{renderPane(node.groupId)}</div>;
	}

	// Split node — render allotment container with debounced size persistence
	return <SplitRenderer node={node} docs={docs} renderPane={renderPane} />;
};

/**
 * Props for the split renderer component.
 */
interface SplitRendererProps {
	/** The split node to render. */
	node: LayoutSplit;
	/** The Documents instance. */
	docs: Documents;
	/** Render function for leaf panes. */
	renderPane: (groupId: string) => React.ReactNode;
}

/**
 * Renders an Allotment split container for a LayoutSplit node.
 * Debounces the onChange callback to avoid excessive state updates during drag.
 *
 * @param props.node       - The split node.
 * @param props.docs       - The Documents instance.
 * @param props.renderPane - Callback that renders leaf pane content.
 */
const SplitRenderer: React.FC<SplitRendererProps> = ({ node, docs, renderPane }) => {
	const timerRef = useRef<ReturnType<typeof setTimeout>>();
	const nodeIdRef = useRef(node.id);
	const mountedRef = useRef(false);
	nodeIdRef.current = node.id;

	/**
	 * Debounced handler for allotment resize events.
	 * Skips the initial onChange that fires on mount to prevent persisting
	 * stale/transitional sizes.  Only persists after user-initiated resizes.
	 */
	const handleSizeChange = useCallback((sizes: number[]) => {
		// Skip the initial onChange fired by allotment on mount
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		// Ignore degenerate sizes (both must be positive)
		if (sizes[0]! <= 0 || sizes[1]! <= 0) return;
		clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			docs.updateSplitSizes(nodeIdRef.current, [sizes[0]!, sizes[1]!]);
		}, SIZE_DEBOUNCE_MS);
	}, [docs]);

	return (
		<Allotment key={node.id} vertical={node.orientation === 'vertical'} onChange={handleSizeChange}>
			<Allotment.Pane minSize={MIN_PANE_SIZE} preferredSize={node.sizes?.[0]}>
				<LayoutNodeRenderer node={node.children[0]} docs={docs} renderPane={renderPane} />
			</Allotment.Pane>
			<Allotment.Pane minSize={MIN_PANE_SIZE} preferredSize={node.sizes?.[1]}>
				<LayoutNodeRenderer node={node.children[1]} docs={docs} renderPane={renderPane} />
			</Allotment.Pane>
		</Allotment>
	);
};

export default DocSplitLayout;
