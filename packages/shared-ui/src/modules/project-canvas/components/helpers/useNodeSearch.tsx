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

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Node, useReactFlow } from '@xyflow/react';
import { useFlow } from '../../FlowContext';
import { brandOrange } from '../../../../theme';

/**
 * Hook that provides search-and-navigate functionality for canvas nodes.
 * Maintains search visibility, query text, matching results, and the current result index.
 * When the user searches, matching nodes are highlighted with an orange outline and the
 * viewport pans to center on the active result. Supports cycling forward and backward
 * through results, enabling quick discovery of specific nodes in large pipelines.
 *
 * @returns An object containing search state and control functions:
 *   - `isSearchVisible` / `toggleSearch` - controls the search UI visibility
 *   - `searchQuery` / `performSearch` - the current query and setter
 *   - `searchResults` / `currentSearchResultIndex` - matched nodes and active index
 *   - `goToNextSearchResult` / `goToPreviousSearchResult` - result cycling
 */
export function useNodeSearch() {
	const { nodes, setNodes, setSelectedNodeId, servicesJson } = useFlow();

	const { getViewport } = useReactFlow();
	const reactFlowInstance = useReactFlow();

	const [isSearchVisible, setIsSearchVisible] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<Node[]>([]);
	const [currentSearchResultIndex, setCurrentSearchResultIndex] = useState(-1);

	// Derive the ID of the currently focused search result for highlight and pan effects
	const currentSearchResultId = useMemo(() => {
		if (currentSearchResultIndex > -1 && searchResults[currentSearchResultIndex]) {
			return searchResults[currentSearchResultIndex].id;
		}
		return null;
	}, [searchResults, currentSearchResultIndex]);

	const toggleSearch = useCallback(() => {
		setIsSearchVisible((prev) => {
			// When closing the search panel, clear all search state so old highlights are removed
			if (prev) {
				setSearchQuery('');
				setSearchResults([]);
				setCurrentSearchResultIndex(-1);
			}
			return !prev;
		});
	}, []);

	const performSearch = useCallback(
		(query: string) => {
			setSearchQuery(query);
			// Empty query: reset results and index so highlights are cleared
			if (!query) {
				setSearchResults([]);
				setCurrentSearchResultIndex(-1);
				return;
			}
			// Case-insensitive substring match against the user name or service catalog title
			const services = servicesJson as Record<string, { title?: string }> | undefined;
			const results = nodes.filter((node: Node) => {
				const displayName = (node.data.name as string) || services?.[node.data.provider as string]?.title || '';
				return displayName.toLowerCase().includes(query.toLowerCase());
			});
			setSearchResults(results);
			// Auto-focus the first match, or -1 when there are no hits
			setCurrentSearchResultIndex(results.length > 0 ? 0 : -1);
		},
		[nodes]
	);

	const goToNextSearchResult = useCallback(() => {
		if (searchResults.length === 0) return;
		// Wrap around to the first result after reaching the last one
		setCurrentSearchResultIndex((prev) => (prev + 1) % searchResults.length);
	}, [searchResults.length]);

	const goToPreviousSearchResult = useCallback(() => {
		if (searchResults.length === 0) return;
		// Wrap around to the last result when moving backward past the first one
		setCurrentSearchResultIndex(
			(prev) => (prev - 1 + searchResults.length) % searchResults.length
		);
	}, [searchResults.length]);

	// Apply or remove the orange outline on each node whenever the active result changes
	useEffect(() => {
		setNodes((currentNodes) =>
			currentNodes.map((node) => {
				const isCurrentSearchResult = currentSearchResultId === node.id;
				const newStyle = { ...node.style };
				// Only the actively focused result gets the highlight; all others are cleared
				newStyle.outline = isCurrentSearchResult ? `2px solid ${brandOrange}` : undefined;
				return { ...node, style: newStyle };
			})
		);
	}, [currentSearchResultId, setNodes]);

	// Pan the viewport to center on the active search result whenever it changes
	useEffect(() => {
		if (currentSearchResultIndex >= 0 && currentSearchResultIndex < searchResults.length) {
			const node = searchResults[currentSearchResultIndex];
			if (node) {
				// Mark only the active search result as selected so the node panel can show its details
				setNodes((nds) =>
					nds.map((n) => ({
						...n,
						selected: n.id === node.id,
					}))
				);
				// Sync the flow context's selected-node-id for external consumers
				setSelectedNodeId(node.id);

				// Preserve the current zoom level while panning
				const { zoom } = getViewport();

				// Smoothly animate the viewport to center on the matched node
				reactFlowInstance.fitView({
					nodes: [{ id: node.id }],
					duration: 300,
					minZoom: zoom,
					maxZoom: zoom,
				});
			}
		}
	}, [
		currentSearchResultIndex,
		searchResults,
		getViewport,
		reactFlowInstance,
		setNodes,
		setSelectedNodeId,
	]);

	return {
		isSearchVisible,
		toggleSearch,
		searchQuery,
		performSearch,
		searchResults,
		currentSearchResultIndex,
		goToNextSearchResult,
		goToPreviousSearchResult,
	};
}
