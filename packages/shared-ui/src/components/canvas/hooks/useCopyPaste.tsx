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

/**
 * Copy/paste hooks for the flow canvas.
 *
 * Provides `useCopy()` and `usePaste()` hooks that share a module-level
 * clipboard. Copy captures the currently selected nodes and their internal
 * edges; paste duplicates them with fresh IDs and offset positions.
 */

import { useCallback, useMemo } from 'react';
import { Node, Edge } from '@xyflow/react';

import { useFlow } from './useFlowContext';
import { generateNodeId } from '../util/graph';
import { uuid } from '../util/uuid';
import { INodeData } from '../types';

/** ReactFlow Node with strongly-typed data. */
type FlowNode = Node<INodeData>;

// =============================================================================
// Module-level clipboard (shared between useCopy and usePaste)
// =============================================================================

/**
 * Holds a deep copy of the most recently copied nodes and their internal edges.
 * Module-scoped so paste can access data captured by copy without prop-drilling.
 */
const clipboardRef: { current: { nodes: FlowNode[]; edges: Edge[] } | null } = {
	current: null,
};

// =============================================================================
// useCopy
// =============================================================================

/**
 * Hook that provides a copy handler for the flow canvas.
 *
 * Captures the currently selected nodes and their internal edges into
 * the module-level clipboard.
 *
 * @returns A memoized callback that copies the current selection.
 */
export function useCopy() {
	const { nodes, edges } = useFlow();
	const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

	const copy = useCallback(() => {
		if (selectedNodes.length === 0) {
			clipboardRef.current = null;
			return;
		}

		const selection = [...selectedNodes];

		// Build lookup set for fast edge-membership checks
		const ids = new Set(selection.map((n: FlowNode) => n.id));

		// Only keep edges where both endpoints are in the selection
		const internalEdges = edges.filter((e: Edge) => ids.has(e.source) && ids.has(e.target));

		// Deep-copy to decouple from live React Flow node references
		clipboardRef.current = {
			nodes: JSON.parse(JSON.stringify(selection)),
			edges: JSON.parse(JSON.stringify(internalEdges)),
		};
	}, [selectedNodes, edges]);

	return copy;
}

// =============================================================================
// usePaste
// =============================================================================

/**
 * Hook that provides a paste handler for the flow canvas.
 *
 * Duplicates clipboard contents with fresh IDs, offsets positions by 20px
 * diagonally, and appends them to the canvas. Successive pastes cascade.
 *
 * @returns A memoized callback that pastes clipboard contents.
 */
export function usePaste() {
	const { nodes, setNodes, setEdges, onContentUpdated } = useFlow();

	const paste = useCallback(() => {
		if (!clipboardRef.current) return;

		const { nodes: copiedNodes, edges: copiedEdges } = clipboardRef.current;
		if (copiedNodes.length === 0) return;

		// Map old IDs to fresh ones
		const idMapping = new Map<string, string>();
		const newNodes: FlowNode[] = [];

		copiedNodes.forEach((node) => {
			const newId = generateNodeId(nodes, node.data.provider);
			idMapping.set(node.id, newId);

			// Offset so paste is visually distinct from original
			const newPosition = { x: node.position.x + 20, y: node.position.y + 20 };

			// Remap parentId for child nodes
			const newParentId = node.parentId ? idMapping.get(node.parentId) : undefined;

			newNodes.push({
				...node,
				id: newId,
				position: newPosition,
				selected: true,
				parentId: newParentId,
				data: { ...node.data },
			});
		});

		// Remap edge endpoints to new IDs
		const newEdges: Edge[] = copiedEdges.map((edge) => ({
			...edge,
			id: uuid(),
			source: idMapping.get(edge.source)!,
			target: idMapping.get(edge.target)!,
		}));

		// Advance clipboard positions for cascading pastes
		clipboardRef.current = {
			...clipboardRef.current,
			nodes: newNodes.map((n) => ({ ...n, selected: false })),
		};

		// Deselect existing, append pasted (pre-selected)
		setNodes((current) => [...current.map((n) => ({ ...n, selected: false })), ...newNodes]);
		setEdges((current: Edge[]) => [...current, ...newEdges]);
		onContentUpdated();
	}, [nodes, setNodes, setEdges, onContentUpdated]);

	return paste;
}
