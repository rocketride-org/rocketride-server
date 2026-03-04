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

import { IQueryBuilderConfig, IQueryBuilderConfigFlat } from './types';
import { IMenuItem } from '../basic-nested-menu/BasicNestedMenu';

/**
 * Flattens a hierarchical query builder configuration tree into a flat dictionary
 * keyed by each config node's unique key. Only leaf nodes (those with a `value`) are
 * included in the result. This enables O(1) lookups when resolving field settings
 * for individual query rows.
 *
 * @param configList - The top-level array of hierarchical configuration nodes.
 * @returns A flat dictionary mapping config keys to their leaf configuration objects.
 */
export const flattenConfig = (configList: IQueryBuilderConfig[]): IQueryBuilderConfigFlat => {
	const map: { [key: string]: IQueryBuilderConfig } = {};
	// Use a BFS queue to traverse the entire config tree level by level
	const queue: IQueryBuilderConfig[] = [...configList];

	while (queue.length) {
		const curr = queue.shift();

		// Only leaf nodes (those with a value) are added to the flat map;
		// category/branch nodes are skipped since they aren't selectable fields
		if (curr?.value) {
			map[curr.key] = { ...curr };
		}

		// Enqueue child nodes so their subtrees are also processed
		if (curr?.items) {
			for (const next of curr.items) queue.push(next);
		}
	}

	return map;
};

/**
 * Recursively searches the hierarchical configuration tree and returns the first
 * leaf node that has a `value` property. This is used to determine the default
 * field selection when the user adds a new query row.
 *
 * @param configList - The configuration tree (or subtree) to search.
 * @returns The first config node with a value, or null if none is found.
 */
export const findFirstConfigWithValue = (
	configList: IQueryBuilderConfig[]
): IQueryBuilderConfig | null => {
	let found = null;
	for (const config of configList) {
		// If this node is a leaf with a value, return it immediately as the first match
		if (config?.value) {
			return config;
		}
		// Otherwise recurse into children to find a leaf deeper in the tree
		if (config.items) {
			found = findFirstConfigWithValue(config.items);
			if (found) {
				return found;
			}
		}
	}
	// No leaf node with a value exists anywhere in the tree
	return null;
};

/**
 * Recursively converts a query builder configuration tree into a nested menu item
 * structure compatible with the `BasicNestedMenu` / `BasicNestedMenuSelect` components.
 * This transformation bridges the query builder config format to the generic menu format
 * so users can navigate and select fields through a nested dropdown.
 *
 * @param configList - The array of configuration nodes to convert.
 * @returns A nested array of menu items mirroring the config hierarchy.
 */
export const buildMenuItems = (configList: IQueryBuilderConfig[]): IMenuItem[] => {
	const items: IMenuItem[] = [];

	for (const curr of configList) {
		// Recursively convert child config nodes into nested menu items first
		const childItems = buildMenuItems(curr.items ?? []);
		// Map config properties to the IMenuItem shape expected by BasicNestedMenu
		const item: IMenuItem = {
			key: curr.key ?? '',
			label: curr.label ?? '',
			value: curr.value,
			valueLabel: curr.valueLabel,
			items: childItems,
		};
		items.push(item);
	}

	return items;
};
