// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import { ReactElement, ReactNode, createContext, useContext, useMemo, CSSProperties } from 'react';

import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Box, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { styles } from './QueryBuilderDraggable.style';

/**
 * Context shape for sharing dnd-kit sortable attributes, event listeners, and the
 * activator node ref from the sortable item to its nested DragHandle component.
 */
interface Context {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	attributes: Record<string, any>;
	listeners: DraggableSyntheticListeners;
	ref(node: HTMLElement | null): void;
}

/**
 * React context that provides dnd-kit sortable interaction props (attributes, listeners, ref)
 * to descendant components -- specifically the DragHandle. This decouples the drag handle
 * from the sortable wrapper so the handle can be rendered anywhere within the row.
 */
const SortableItemContext = createContext<Context>({
	attributes: {},
	listeners: undefined,
	ref() {},
});

/**
 * Renders a six-dot grip icon that serves as the drag handle for a sortable query row.
 * Consumes the SortableItemContext to wire up dnd-kit drag listeners and accessibility
 * attributes. Positioned at the left edge of each draggable row.
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
 * Props for the {@link QueryBuilderDraggable} component.
 */
interface IQueryBuilderDraggableProps {
	/** Unique sortable item ID, matching the query row's `id`. */
	id: string;
	/** Callback fired when the user clicks the delete button for this row. */
	onClickRemove: (id: string) => void;
	/** When true, disables the delete button for this row. */
	disabled?: boolean;
	/** The query row content rendered between the drag handle and the delete button. */
	children: ReactNode;
}

/**
 * Wraps a single query builder row with drag-and-drop reordering capability.
 * Renders a drag handle on the left and a delete button on the right, with the
 * row's content (field selector, operator, input, unit) in the center.
 * Uses dnd-kit's `useSortable` hook for smooth drag animations and keyboard support.
 *
 * @param props - See {@link IQueryBuilderDraggableProps} for available props.
 * @returns A sortable row element with drag handle, content, and delete button.
 */
export default function QueryBuilderDraggable({
	id,
	disabled,
	onClickRemove,
	children,
}: IQueryBuilderDraggableProps): ReactElement {
	// Initialize dnd-kit sortable hook to get drag state and DOM refs
	const {
		attributes,
		isDragging,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
	} = useSortable({ id });

	// Memoize the context value to avoid re-rendering all descendants on every render;
	// passes drag attributes and listeners down to the DragHandle via context
	const context = useMemo(
		() => ({
			attributes,
			listeners,
			ref: setActivatorNodeRef,
		}),
		[attributes, listeners, setActivatorNodeRef]
	);

	// Reduce opacity while this item is being dragged to indicate it's the source.
	// Transform and transition provide the smooth positional animation.
	const animatedStyle: CSSProperties = {
		opacity: isDragging ? 0.4 : undefined,
		transform: CSS.Translate.toString(transform),
		transition,
	};

	return (
		<SortableItemContext.Provider value={context}>
			<Box ref={setNodeRef} sx={styles.root} style={animatedStyle}>
				<DragHandle />
				<Box sx={{ width: 1, display: 'flex' }}>{children}</Box>
				<IconButton
					sx={{ ml: 1 }}
					onClick={() => onClickRemove(id)}
					disabled={disabled}
					size="small"
				>
					<DeleteIcon />
				</IconButton>
			</Box>
		</SortableItemContext.Provider>
	);
}
