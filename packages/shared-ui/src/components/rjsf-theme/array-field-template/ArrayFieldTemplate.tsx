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

import { useMemo, useEffect, useState, PropsWithChildren } from 'react';
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
import { SortableContext, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToWindowEdges } from '@dnd-kit/modifiers';
import Box from '@mui/material/Box';
import {
	getTemplate,
	getUiOptions,
	ArrayFieldTemplateProps,
	ArrayFieldTemplateItemType,
	FormContextType,
	RJSFSchema,
	StrictRJSFSchema,
} from '@rjsf/utils';

/**
 * Configuration for the drop animation displayed when an array item finishes
 * being dragged. Reduces the active item's opacity during the transition
 * to provide a smooth visual cue.
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
 * Empty props interface for the SortableOverlay component.
 * Combined with PropsWithChildren to accept only a children prop.
 */
interface Props {
	// Intentionally empty - uses PropsWithChildren for children prop only
}

/**
 * Renders a DragOverlay from dnd-kit that displays a floating preview of
 * the array item currently being dragged. Provides visual feedback during
 * reorder operations.
 */
export function SortableOverlay({ children }: PropsWithChildren<Props>) {
	return <DragOverlay dropAnimation={dropAnimationConfig}>{children}</DragOverlay>;
}

/**
 * Custom RJSF template for rendering array fields with drag-and-drop reordering.
 * Uses dnd-kit's SortableContext to enable vertical item reordering via pointer
 * and keyboard sensors. Renders each item through the ArrayFieldItemTemplate,
 * a floating overlay for the item being dragged, and an "Add" button when
 * the schema allows additional items.
 */
export default function ArrayFieldTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	canAdd,
	disabled,
	idSchema,
	uiSchema,
	items,
	onAddClick,
	readonly,
	registry,
	required,
	schema,
	title,
}: ArrayFieldTemplateProps<T, S, F>) {
	// Local copy of items for optimistic reorder before RJSF re-renders with the updated array
	const [_items, setSortableItems] = useState(items);

	// Sync local items whenever the parent form provides a new items array
	useEffect(() => {
		setSortableItems(items);
	}, [items]);

	// dnd-kit requires a unique numeric `id` on each item; offset by +1 because id=0 is falsy
	const sortableItems = _items.map((item) => ({
		id: item.index + 1,
		...item,
	}));

	// Track the currently dragged item so we can render its preview in the SortableOverlay
	const [active, setActive] = useState<Active | null>(null);
	const activeItem = useMemo(
		() => sortableItems.find((item) => item.id === active?.id),
		[active, sortableItems]
	);

	// Configure pointer and keyboard sensors for drag-and-drop interactions
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		})
	);

	const uiOptions = getUiOptions<T, S, F>(uiSchema);

	// Resolve the RJSF sub-templates from the registry, allowing uiSchema overrides
	const ArrayFieldDescriptionTemplate = getTemplate<'ArrayFieldDescriptionTemplate', T, S, F>(
		'ArrayFieldDescriptionTemplate',
		registry,
		uiOptions
	);

	const ArrayFieldItemTemplate = getTemplate<'ArrayFieldItemTemplate', T, S, F>(
		'ArrayFieldItemTemplate',
		registry,
		uiOptions
	);

	const ArrayFieldTitleTemplate = getTemplate<'ArrayFieldTitleTemplate', T, S, F>(
		'ArrayFieldTitleTemplate',
		registry,
		uiOptions
	);

	// Button templates are not overridden in the uiSchema
	const {
		ButtonTemplates: { AddButton },
	} = registry.templates;

	return (
		<Box>
			<ArrayFieldTitleTemplate
				idSchema={idSchema}
				title={uiOptions.title || title}
				schema={schema}
				uiSchema={uiSchema}
				required={required}
				registry={registry}
			/>
			<ArrayFieldDescriptionTemplate
				idSchema={idSchema}
				description={uiOptions.description || schema.description}
				schema={schema}
				uiSchema={uiSchema}
				registry={registry}
			/>
			<Box sx={{ pt: 1 }}>
				<DndContext
					sensors={sensors}
					modifiers={[restrictToVerticalAxis, restrictToWindowEdges]}
					onDragStart={({ active }) => {
						setActive(active);
					}}
					onDragEnd={({ active, over }) => {
						if (over && active.id !== over?.id) {
							// Calculate source and destination positions from the sortable list
							const activeIndex = sortableItems.findIndex(
								({ id }) => id === active.id
							);
							const overIndex = sortableItems.findIndex(({ id }) => id === over.id);
							// Optimistically reorder local state for immediate visual feedback
							setSortableItems(arrayMove(items, activeIndex, overIndex));
							// Trigger the RJSF reorder callback to persist the new order in form data
							items[0].onReorderClick(activeIndex, overIndex)();
						}
						setActive(null);
					}}
					onDragCancel={() => {
						setActive(null);
					}}
				>
					<SortableContext items={sortableItems}>
						{sortableItems &&
							sortableItems.map(
								(
									{ key, ...itemProps }: ArrayFieldTemplateItemType<T, S, F>,
									index: number
								) => (
									<ArrayFieldItemTemplate
										key={key}
										{...itemProps}
										// @ts-expect-error isLast is a custom prop accepted by our ArrayFieldItemTemplate
										isLast={index === sortableItems.length - 1}
									/>
								)
							)}
					</SortableContext>
					<SortableOverlay>
						{activeItem
							? [activeItem].map(
									({
										key,
										...itemProps
									}: ArrayFieldTemplateItemType<T, S, F>) => (
										// @ts-expect-error isLast is a custom prop accepted by our ArrayFieldItemTemplate
									<ArrayFieldItemTemplate key={key} {...itemProps} isLast />
									)
								)
							: null}
					</SortableOverlay>
				</DndContext>
				{canAdd && (
					<AddButton
						className="array-item-add"
						onClick={onAddClick}
						disabled={disabled || readonly}
						uiSchema={uiSchema}
						registry={registry}
					/>
				)}
			</Box>
		</Box>
	);
}
