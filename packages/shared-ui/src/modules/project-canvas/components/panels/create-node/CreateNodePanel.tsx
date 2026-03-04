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

import React, { ReactNode, useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import {
	IDynamicForms,
	IDynamicForm,
	DynamicFormsCapabilities,
} from '../../../../../services/dynamic-forms/types';

import { IBasePanelProps } from '../types';
import CreateNodeGroup from './CreateNodeGroup';
import CreateNodeItem from './CreateNodeItem';
import { useFlow } from '../../../FlowContext';
import BasePanel from '../BasePanel';
import BasePanelHeader from '../BasePanelHeader';
import ListPanelBody from './ListPanelBody';

/**
 * Extracts the set of input lane keys (top-level keys of the lanes record).
 * Used to determine which data types a node can accept as input.
 *
 * @param lanes - Record mapping input lane names to arrays of output lane names.
 * @returns A Set of input lane key strings.
 */
function getLanesInputKeys(lanes: Record<string, string[]> = {}): Set<string> {
	// Input lanes are the top-level keys of the lanes record (e.g. "text", "image")
	return new Set(Object.keys(lanes));
}

/**
 * Extracts the set of output lane keys (all values flattened from the lanes record).
 * Used to determine which data types a node produces as output.
 *
 * @param lanes - Record mapping input lane names to arrays of output lane names.
 * @returns A Set of output lane key strings.
 */
function getLanesOutputKeys(lanes: Record<string, string[]> = {}): Set<string> {
	// Output lanes are all values from the lanes record, flattened into a single set
	return new Set(
		Object.values(lanes).reduce((acc, curr) => (acc as string[]).concat(curr as string[]), [])
	);
}

/**
 * Checks whether two sets share no common elements.
 * Used during inventory filtering to determine if a node's lanes are
 * compatible with the currently selected handle.
 *
 * @param setA - First set to compare.
 * @param setB - Second set to compare.
 * @returns `true` if the sets have no elements in common.
 */
function areDisjoint(setA: Set<string>, setB: Set<string>): boolean {
	let disjoint = true;
	setA.forEach((item) => {
		if (setB.has(item)) {
			disjoint = false;
		}
	});
	return disjoint;
}

/** Human-readable display titles for each node category/group key. */
const titles: Record<string, string> = {
	source: 'Source',
	embedding: 'Embedding',
	llm: 'LLM',
	database: 'Database',
	filter: 'Filter',
	image: 'Image',
	preprocessor: 'Preprocessor',
	store: 'Store',
	other: 'Other',
};

/**
 * Builds a mapping of group keys to their translated tooltip descriptions.
 * These tooltips appear when hovering over a group header in the add-node panel.
 *
 * @param t - i18n translation function.
 * @returns Record mapping group keys to localized tooltip strings.
 */
const getTooltips = (t: (key: string) => string): Record<string, string> => ({
	source: t('flow.panels.headerTooltips.source'),
	embedding: t('flow.panels.headerTooltips.embedding'),
	llm: t('flow.panels.headerTooltips.llm'),
	database: t('flow.panels.headerTooltips.database'),
	filter: t('flow.panels.headerTooltips.filter'),
	image: t('flow.panels.headerTooltips.image'),
	preprocessor: t('flow.panels.headerTooltips.preprocessor'),
	other: t('flow.panels.headerTooltips.other'),
	audio: t('flow.panels.headerTooltips.audio'),
	target: t('flow.panels.headerTooltips.target'),
	text: t('flow.panels.headerTooltips.text'),
	infrastructure: t('flow.panels.headerTooltips.infrastructure'),
	store: t('flow.panels.headerTooltips.store'),
	data: t('flow.panels.headerTooltips.data'),
});

/**
 * Renders the "Add Node" side panel on the project canvas. Displays the
 * full inventory of available pipeline node types organized into collapsible
 * groups (Source, LLM, Database, etc.). Supports text search, handle-based
 * compatibility filtering, and both click-to-add and drag-to-add interactions.
 *
 * @param onClose - Callback to dismiss the panel.
 */
export default function CreateNodePanel({ onClose }: IBasePanelProps): ReactNode {
	const { t } = useTranslation();

	const {
		addNode,
		addRemoteGroupNode,
		setTempNode,
		selectedHandle,
		setSelectedHandle,
		inventory: _inventory,
	} = useFlow();

	/** Memoized inventory ensuring a stable default empty object. */
	const inventory = useMemo(() => (_inventory ?? {}) as Record<string, IDynamicForms>, [_inventory]);

	const [search, setSearch] = useState<string>('');

	/**
	 * Builds human-readable filter labels from the currently selected handle,
	 * indicating which input or output data types are being filtered.
	 */
	const filters = useMemo(() => {
		const _filters = [];
		// Iterate over the data-type keys from the selected handle (index [2])
		for (const key of selectedHandle?.[2] ?? []) {
			// If the handle is a source handle, the compatible nodes need a matching input;
			// if it's a target handle, compatible nodes need a matching output
			const name = selectedHandle?.[1].includes('source')
				? `Input: ${key}`
				: `Output: ${key}`;
			_filters.push(name);
		}
		return _filters;
	}, [selectedHandle]);

	/** Clears the active handle-based filter, restoring the full node inventory view. */
	const onDeleteFilter = () => {
		setSelectedHandle(undefined, undefined, undefined);
	};

	// Reset the search text whenever the handle-based filter changes
	useEffect(() => {
		setSearch('');
	}, [selectedHandle]);

	/**
	 * Filters the full node inventory based on the current search text and
	 * handle compatibility constraints. Nodes are excluded if they are
	 * deprecated, do not match the search query, or have incompatible
	 * lane types relative to the selected handle.
	 */
	const filteredInventory = useMemo(() => {
		// Build sets of compatible data-type keys from the selected handle direction
		// "target" handle means we need nodes that produce matching outputs
		const inputKeys = selectedHandle?.[1] === 'target' ? new Set(selectedHandle[2]) : new Set<string>();
		// "source" handle means we need nodes that accept matching inputs
		const outputKeys = selectedHandle?.[1] === 'source' ? new Set(selectedHandle[2]) : new Set<string>();
		// Invoke handles are a separate connection mechanism for inter-node function calls
		const invokeInputKeys = selectedHandle?.[1]?.includes('invoke-target')
			? new Set(selectedHandle[2])
			: new Set<string>();
		const invokeOutputKeys = selectedHandle?.[1]?.includes('invoke-source')
			? new Set(selectedHandle[2])
			: new Set<string>();

		const map: { [key: string]: IDynamicForms } = {};

		for (const [groupKey, groupValue] of Object.entries(inventory) as [string, IDynamicForms][]) {
			const group: IDynamicForms = {};
			for (const [itemKey, itemValue] of Object.entries(groupValue) as [
				string,
				IDynamicForm,
			][]) {
				const title = (itemValue.title ?? '').toLowerCase();

				// Exclude items that don't match the text search query
				if (!title.includes(search.toLowerCase())) continue;

				// Hide deprecated drivers from the UI while keeping them functional for existing pipelines
				const isDeprecated =
					itemValue.capabilities &&
					(DynamicFormsCapabilities.Deprecated & itemValue.capabilities) ===
						DynamicFormsCapabilities.Deprecated;
				if (isDeprecated) continue;

				// If a handle is selected but none of the key sets have entries,
				// this node has no compatible connections -- skip it
				if (
					!inputKeys.size &&
					!outputKeys.size &&
					!invokeInputKeys.size &&
					!invokeOutputKeys.size &&
					selectedHandle
				)
					continue;

				// Check lane compatibility: the candidate node's outputs must overlap
				// with the selected handle's required input types
				const _outputKeys = getLanesOutputKeys(itemValue.lanes as Record<string, string[]>);
				if (inputKeys.size && areDisjoint(inputKeys, _outputKeys)) continue;

				// Similarly, the candidate's inputs must overlap with the required output types
				const _inputKeys = getLanesInputKeys(itemValue.lanes as Record<string, string[]>);
				if (outputKeys.size && areDisjoint(outputKeys, _inputKeys)) continue;

				// For invoke connections, match the node's classType against invoke-source requirements
				const _invokeOutputKeys = new Set<string>(
					Array.isArray(itemValue.classType) ? (itemValue.classType as string[]) : [String(itemValue.classType ?? '')]
				);
				if (invokeOutputKeys.size && areDisjoint(invokeOutputKeys, _invokeOutputKeys))
					continue;

				// Match the node's invoke inputs against invoke-target requirements
				const _invokeInputKeys = new Set(Object.keys(itemValue.invoke ?? {}));
				if (invokeInputKeys.size && areDisjoint(invokeInputKeys, _invokeInputKeys))
					continue;

				// Node passed all filters -- include it in the result
				group[itemKey] = itemValue;
			}

			// Only include groups that have at least one matching item
			if (Object.keys(group).length) {
				map[groupKey] = group;
			}
		}

		return map;
	}, [search, inventory, selectedHandle]);

	/**
	 * Handles adding a node to the canvas when the user clicks an item.
	 * Delegates to `addRemoteGroupNode` for remote nodes or `addNode`
	 * for all other pipe node types.
	 */
	const onClickItem = (groupKey: string, itemKey: string) => {
		// Render remote box node
		if (itemKey === 'remote') {
			const { title, icon, classType, Pipe } = inventory[groupKey][itemKey];
			addRemoteGroupNode({
				title,
				icon,
				classType,
				Pipe,
				provider: itemKey,
			});
		}

		// Render all other pipe nodes
		else {
			const {
				title,
				icon,
				classType,
				capabilities,
				invoke,
				lanes,
				Pipe,
				type,
				content,
				tile,
				documentation,
			} = inventory[groupKey][itemKey];
			addNode({
				title,
				icon,
				classType,
				capabilities,
				invoke,
				lanes,
				Pipe,
				type,
				content,
				tile,
				documentation,
				class: groupKey,
				provider: itemKey,
			});
		}
	};

	/**
	 * Initiates a drag operation by setting the temporary node data in context.
	 * The canvas drop handler reads this data to create the node at the drop position.
	 */
	const onDragStart = (event: React.DragEvent, groupKey: string, itemKey: string) => {
		// Extract all node metadata from the inventory to populate the temporary drag node
		const { title, icon, classType, capabilities, invoke, lanes, Pipe, type, content, tile } =
			inventory[groupKey][itemKey];

		// Store the dragged node data in context so the canvas drop handler can create it
		setTempNode({
			title,
			icon,
			classType,
			capabilities,
			invoke,
			lanes,
			Pipe,
			type,
			content,
			tile,
			class: groupKey,
			provider: itemKey,
		});

		// Set the drag effect to "move" so the browser shows the appropriate cursor
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
		}
	};

	/**
	 * Builds the JSX for all filtered node groups, rendering each category
	 * as a collapsible CreateNodeGroup containing CreateNodeItem entries.
	 */
	const buildGroups = () => {
		const tooltips = getTooltips(t);

		return Object.entries(filteredInventory).map(
			([groupKey, groupValue]: [string, IDynamicForms]) => {
				// If any item in the group has `focus`, dim all non-focused items
				const groupHasFocus = Object.values(groupValue).some(
					(itemValue: IDynamicForm) => itemValue.focus
				);
				const items = Object.entries(groupValue).map(
					([itemKey, itemValue]: [string, IDynamicForm]) => {
						// Plan/subscription filtering is handled by the host's runPipeline callback
						const hasPlan = true;

						return (
							<CreateNodeItem
								key={itemKey}
								title={itemValue.title ?? ''}
								icon={itemValue.icon ?? ''}
								description={itemValue.description}
								documentation={itemValue.documentation}
								disabled={groupHasFocus && !itemValue.focus}
								disabledInvalidPlan={!hasPlan}
								onClick={() => onClickItem(groupKey, itemKey)}
								onDragStart={(event) => onDragStart(event, groupKey, itemKey)}
							/>
						);
					}
				);

				// Use the human-readable title if available, otherwise fall back to the raw groupKey
				const title = groupKey in titles ? titles[groupKey] : groupKey;
				const tooltip: string = tooltips[groupKey] ?? '';

				return (
					<CreateNodeGroup key={groupKey} title={title} tooltip={tooltip}>
						{items}
					</CreateNodeGroup>
				);
			}
		);
	};

	return (
		<BasePanel width={400} id="actions-panel">
			<BasePanelHeader title={t('flow.panels.createNode.header')} onClose={onClose} />
			<ListPanelBody
				filters={filters}
				onSearchCallback={(value?: string) => setSearch(value ?? '')}
				onDeleteFilterCallback={onDeleteFilter}
			>
				<Box
					className="add-node-list-scroll"
					sx={{
						position: 'relative',
						height: '100%',
						minHeight: 0,
						overflowY: 'scroll',
					}}
				>
					<Box
						sx={{
							position: 'absolute',
							top: 0,
							left: 0,
							width: '100%',
							display: 'flex',
							flexDirection: 'column',
							px: '1rem',
							pb: '1rem',
						}}
					>
						{buildGroups()}
					</Box>
				</Box>
			</ListPanelBody>
		</BasePanel>
	);
}
