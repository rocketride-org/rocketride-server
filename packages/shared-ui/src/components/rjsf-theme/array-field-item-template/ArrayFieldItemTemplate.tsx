// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import { createContext, useContext, useMemo, CSSProperties } from 'react';
import type { DraggableSyntheticListeners, UniqueIdentifier } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { styles } from './ArrayFieldItemTemplate.style';
import { Box, Divider, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import {
	ArrayFieldTemplateItemType,
	FormContextType,
	RJSFSchema,
	StrictRJSFSchema,
} from '@rjsf/utils';

/**
 * Context shape for the sortable item, providing drag-and-drop attributes,
 * event listeners, and a ref callback needed by the DragHandle component
 * to initiate drag operations.
 */
interface Context {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	attributes: Record<string, any>;
	listeners: DraggableSyntheticListeners;
	ref(node: HTMLElement | null): void;
}

/**
 * React context that passes drag-and-drop interaction data from the sortable
 * item wrapper down to the DragHandle component, decoupling the handle from
 * the sortable logic.
 */
const SortableItemContext = createContext<Context>({
	attributes: {},
	listeners: undefined,
	ref() {},
});

/**
 * Renders a six-dot grip icon that serves as the drag handle for reordering
 * array field items. Consumes SortableItemContext to attach the required
 * drag-and-drop attributes and listeners.
 */
function DragHandle() {
	const { attributes, listeners, ref } = useContext(SortableItemContext);
	return (
		<Box sx={styles.dragHandle} {...attributes} {...listeners} ref={ref}>
			<svg viewBox="0 0 20 20" width="12">
				<path d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"></path>
			</svg>
		</Box>
	);
}

/**
 * Custom RJSF template for a single item within an array field.
 * Wraps each array entry in a sortable container (via dnd-kit) with a drag handle
 * for reordering and a delete button for removal. A divider is rendered between
 * items (but not after the last one) for visual separation.
 */
export default function ArrayFieldItemTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	/* eslint-disable @typescript-eslint/no-unused-vars */
	id,
	children,
	disabled,
	hasToolbar,
	hasCopy,
	hasMoveDown,
	hasMoveUp,
	hasRemove,
	index,
	onCopyIndexClick,
	onDropIndexClick,
	onReorderClick,
	readonly,
	uiSchema,
	registry,
	isLast,
	/* eslint-enable */
}: ArrayFieldTemplateItemType<T, S, F> & {
	id: UniqueIdentifier;
	isLast?: boolean;
}) {
	// Initialize dnd-kit sortable hooks for this item, binding drag state and transforms
	const {
		attributes,
		isDragging,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
	} = useSortable({ id });

	// Memoize context so the DragHandle can attach drag listeners without re-rendering on every frame
	const context = useMemo(
		() => ({
			attributes,
			listeners,
			ref: setActivatorNodeRef,
		}),
		[attributes, listeners, setActivatorNodeRef]
	);

	// Apply reduced opacity while dragging and CSS transform for smooth position animation
	const animatedStyle: CSSProperties = {
		opacity: isDragging ? 0.4 : undefined,
		transform: CSS.Translate.toString(transform),
		transition,
	};

	// Suppress the title/name on individual array items to avoid redundant labels within the list
	children = {
		...children,
		props: { ...children.props, title: null, name: null },
	};

	return (
		<SortableItemContext.Provider value={context}>
			<Box ref={setNodeRef} sx={styles.root} style={animatedStyle}>
				<DragHandle />
				{children}
				<IconButton
					sx={{ ml: 1 }}
					onClick={() => onDropIndexClick(index)()}
					disabled={disabled}
					size="small"
				>
					<DeleteIcon />
				</IconButton>
			</Box>
			{!isLast && <Divider style={{ width: '30%', margin: '0 auto' }} />}
		</SortableItemContext.Provider>
	);
}
