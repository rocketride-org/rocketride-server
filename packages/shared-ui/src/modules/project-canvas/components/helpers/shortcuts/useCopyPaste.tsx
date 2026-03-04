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

import { useCallback } from 'react';
import { Node, Edge } from '@xyflow/react';
import { useFlow } from '../../../FlowContext';
import { generateId } from '../../../helpers';
import { uuid } from '../../../../../utils/uuid';
import { INodeData } from '../../../types';

/**
 * Module-level clipboard storage shared between useCopy and usePaste.
 * Holds a deep copy of the most recently copied nodes and their internal edges,
 * allowing paste operations to recreate them with fresh identifiers.
 */
const clipboardRef: { current: { nodes: Node[]; edges: Edge[] } | null } = {
	current: null,
};

/**
 * Hook that provides a copy handler for the project canvas.
 * Captures the currently selected nodes (including children of locked groups) and
 * their internal edges into a module-level clipboard so they can later be pasted.
 *
 * @returns A memoized callback that copies the current selection to the clipboard.
 */
export function useCopy() {
	const { nodes, edges, selectedNodes } = useFlow();
	const childrenInGroup = useCallback((selectedNodes: Node[]) => {
		// Check if any selected group node is locked (its children must travel with it)
		if (selectedNodes.some((node: Node) => node.type === 'group' && (node.data as INodeData).isLocked)) {
			// Isolate just the locked group parents from the selection
			const parentNodes = selectedNodes.filter(
				(node: Node) => node.type === 'group' && (node.data as INodeData).isLocked
			);

			// Collect all child nodes belonging to these locked groups so they get copied too
			const children: Node[] = parentNodes.reduce((acc: Node[], parent: Node) => {
				const childNodes: Node[] = nodes.filter(
					(node: Node) => node.parentId === parent.id
				);

				return [...acc, ...childNodes];
			}, []);

			return children;
		}
	}, [nodes]);

	const copy = useCallback(() => {
		// Nothing selected: clear the clipboard to avoid stale paste data
		if (selectedNodes.length === 0) {
			clipboardRef.current = null;
			return;
		}

		const _selectedNodes = selectedNodes;

		// If any of the selected nodes are locked in a group,
		// include their children so the paste recreates the full group structure
		const childrenNodes = childrenInGroup(_selectedNodes);

		if (childrenNodes && childrenNodes.length > 0) {
			_selectedNodes.push(...childrenNodes);
		}

		// Build a lookup set for fast edge-membership checks
		const selectedNodeIds = new Set(_selectedNodes.map((node: Node) => node.id));

		// Only keep edges where both endpoints are in the selection (internal edges)
		const internalEdges = edges.filter(
			(edge: Edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target)
		);

		// Deep-copy to decouple clipboard data from live React Flow node references
		clipboardRef.current = {
			nodes: JSON.parse(JSON.stringify(_selectedNodes)),
			edges: JSON.parse(JSON.stringify(internalEdges)),
		};
	}, [selectedNodes, edges, childrenInGroup]);

	return copy;
}

/**
 * Hook that provides a paste handler for the project canvas.
 * Takes nodes and edges stored in the module-level clipboard, creates duplicates
 * with new unique IDs, offsets their positions to avoid overlap, and adds them
 * to the current flow. Also updates the clipboard so successive pastes cascade.
 *
 * @returns A memoized callback that pastes clipboard contents into the canvas.
 */
export function usePaste() {
	const { nodes, setNodes, setEdges, setSelectedNodes, onToolchainUpdated } = useFlow();

	const paste = useCallback(() => {
		// Guard: nothing to paste if clipboard is empty
		if (!clipboardRef.current) {
			return;
		}

		const { nodes: copiedNodes, edges: copiedEdges } = clipboardRef.current;

		if (copiedNodes.length === 0) {
			return;
		}

		// Map old node IDs to freshly generated IDs so pasted nodes are unique
		const idMapping = new Map<string, string>();
		const newNodes: Node[] = [];

		// Create new nodes with unique IDs and offset positions
		copiedNodes.forEach((node) => {
			// Generate a deterministic, collision-free ID based on provider/class name
			const newNodeId = generateId(nodes, ((node.data as INodeData).provider as string) ?? (node.data as INodeData).class);
			idMapping.set(node.id, newNodeId);

			// Offset by 20px diagonally so the paste is visually distinct from the original
			const newPosition = {
				x: node.position.x + 20,
				y: node.position.y + 20,
			};

			// Remap parentId for child nodes so they reference the newly created group node
			const newParentId = node.parentId ? idMapping.get(node.parentId) : undefined;

			newNodes.push({
				...node,
				id: newNodeId,
				position: newPosition,
				selected: true,
				parentId: newParentId,
				data: { ...node.data },
			});
		});

		// Remap edge endpoints to the new node IDs and assign fresh edge IDs
		const newEdges: Edge[] = copiedEdges.map((edge) => ({
			...edge,
			id: uuid(),
			source: idMapping.get(edge.source)!,
			target: idMapping.get(edge.target)!,
		}));

		// Advance clipboard positions so the next paste cascades further, preventing overlap
		clipboardRef.current = {
			...clipboardRef.current,
			nodes: newNodes.map((n) => ({ ...n, selected: false })),
		};

		// Deselect all existing nodes, then append the pasted nodes (which are pre-selected)
		setNodes((currentNodes: Node[]) => [
			...currentNodes.map((n: Node) => ({ ...n, selected: false })),
			...newNodes,
		]);
		setEdges((currentEdges: Edge[]) => [...currentEdges, ...newEdges]);
		// Update the selected-nodes collection to reflect the freshly pasted set
		setSelectedNodes(newNodes);
		// Notify the host that the toolchain has changed (triggers dirty-state / autosave)
		onToolchainUpdated();
	}, [nodes, setNodes, setEdges, setSelectedNodes, onToolchainUpdated]);

	return paste;
}
