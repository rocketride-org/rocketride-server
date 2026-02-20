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

import {
	ReactElement,
	ReactNode,
	Children,
	cloneElement,
	useState,
	PropsWithChildren,
} from 'react';
import { createPortal } from 'react-dom';

import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	DragOverlay,
	defaultDropAnimationSideEffects,
	DropAnimation,
} from '@dnd-kit/core';
import type { Active } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToWindowEdges } from '@dnd-kit/modifiers';
import { IQueryBuilderData } from './types';

/**
 * Props for the {@link QueryBuilderDraggableContainer} component.
 */
interface IQueryBuilderDraggableContainerProps {
	/** The current list of query builder data items, used to map sortable IDs for dnd-kit. */
	items: IQueryBuilderData[];
	/** The draggable row elements to render inside the sortable context. */
	children: ReactNode;
	/** Callback invoked when the user finishes dragging a row to a new position. */
	onReorder: (a: number, b: number) => void;
}

/**
 * Configuration for the drop animation played when a dragged item is released.
 * Applies a fade effect (opacity 0.4) to the active item during the animation.
 */
const dropAnimationConfig: DropAnimation = {
	sideEffects: defaultDropAnimationSideEffects({
		styles: {
			active: {
				opacity: '0.4',
			},
		},
	}),
};

/**
 * Empty props interface for SortableOverlay; children are provided via `PropsWithChildren`.
 */
interface Props {
	// Intentionally empty - uses PropsWithChildren for children prop only
}

/**
 * Renders the drag overlay for the currently active sortable item via a React portal.
 * The overlay is rendered into `document.body` at a high z-index (1200) so it floats
 * above all other UI elements during a drag operation.
 *
 * @param props - Contains optional children to render inside the drag overlay.
 * @returns A portal-mounted DragOverlay wrapping the active item clone.
 */
export function SortableOverlay({ children }: PropsWithChildren<Props>) {
	return createPortal(
		<DragOverlay style={{ zIndex: 1200 }} dropAnimation={dropAnimationConfig}>
			{children}
		</DragOverlay>,
		document.body
	);
}

/**
 * Provides the drag-and-drop context for reordering query builder rows.
 * Wraps child draggable items in a dnd-kit `DndContext` and `SortableContext`,
 * restricting drag movement to the vertical axis and window edges. Tracks the
 * currently active drag item and renders a floating overlay clone during the drag.
 *
 * @param props - See {@link IQueryBuilderDraggableContainerProps} for available props.
 * @returns A DndContext-wrapped container with sortable children and a drag overlay.
 */
export default function QueryBuilderDraggableContainer({
	items,
	children,
	onReorder,
}: IQueryBuilderDraggableContainerProps): ReactElement {
	// Track which item is currently being dragged so we can render its overlay clone
	const [active, setActive] = useState<Active | null>(null);
	// Find the React element matching the actively dragged item by comparing its id prop
	const activeElement = active
		? Children.toArray(children).find((elem) => (elem as React.ReactElement<{ id: string }>)?.props?.id === active.id)
		: null;
	// Clone the active element so the overlay renders a separate copy that
	// floats above the list without disturbing the original DOM node
	const activeElementClone = activeElement ? cloneElement(activeElement as React.ReactElement) : null;

	// Configure both pointer (mouse/touch) and keyboard sensors for accessibility
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		})
	);

	return (
		<DndContext
			sensors={sensors}
			modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
			onDragStart={({ active }) => {
				// Record the currently dragged item to render its overlay clone
				setActive(active);
			}}
			onDragEnd={({ active, over }) => {
				// Only reorder if the item was dropped onto a different position
				if (over && active.id !== over?.id) {
					// Resolve data array indices from the drag source and drop target IDs
					const activeIndex = items.findIndex(({ id }) => id === active.id);
					const overIndex = items.findIndex(({ id }) => id === over.id);
					onReorder(activeIndex, overIndex);
				}
				// Clear active state to dismiss the drag overlay
				setActive(null);
			}}
			onDragCancel={() => {
				// Reset drag state if the user cancels (e.g., pressing Escape)
				setActive(null);
			}}
		>
			<SortableContext items={items}>{children}</SortableContext>
			<SortableOverlay>{activeElementClone}</SortableOverlay>
		</DndContext>
	);
}
