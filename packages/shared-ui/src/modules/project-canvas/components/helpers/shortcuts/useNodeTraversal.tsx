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

import { useEffect } from 'react';
import { useFlow } from '../../../FlowContext';
import { Node } from '@xyflow/react';
import { isEditableElement } from '../../../../../utils/isEditableElement';

/**
 * Props for the {@link useNodeTraversal} hook.
 * Defines the container to listen on and which WASD keys are active for directional traversal.
 */
interface UseNodeTraversalProps {
	/** Ref to the DOM container that holds the navigable canvas nodes. */
	containerRef: React.RefObject<HTMLElement>;
	/** Subset of WASD keys to enable; defaults to all four directions. */
	wasdKeys?: ('w' | 'a' | 's' | 'd')[];
}

/**
 * Hook for keyboard-driven directional navigation between canvas nodes using WASD keys.
 * When a WASD key is pressed, the hook finds the nearest node in the corresponding direction
 * (w = up, a = left, s = down, d = right) from the currently selected node and selects it,
 * also focusing its DOM element. This enables quick spatial traversal of the pipeline graph
 * without a mouse.
 *
 * @param containerRef - A React ref to the container element holding the navigable nodes.
 * @param wasdKeys - An optional array of WASD keys to enable for traversal.
 */
export const useNodeTraversal = ({
	containerRef,
	wasdKeys = ['w', 'a', 's', 'd'],
}: UseNodeTraversalProps) => {
	const {
		actionsPanelType,
		nodes,
		setNodes,
		setSelectedNode,
		selectedNode,
		setSelectedNodes,
		setSelectedNodeId,
	} = useFlow();
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Skip if focused on an editable element to allow native text input behavior
			if (isEditableElement(event.target)) {
				return;
			}

			// Ignore keys not in the enabled WASD set, and suppress traversal while a panel is open
			if (!wasdKeys.includes(event.key as (typeof wasdKeys)[number]) || !!actionsPanelType) {
				return;
			}

			const container = containerRef.current;
			if (!container) return;

			event.preventDefault();

			// Use the currently selected node as the origin, or fall back to the first node
			const currentSelectedNode = selectedNode;
			const startNode = currentSelectedNode || nodes[0];

			if (!startNode) {
				return;
			}

			// Compute the geometric center of the starting node for distance comparisons
			const currentCenter = {
				x: startNode.position.x + (startNode.measured?.width || 0) / 2,
				y: startNode.position.y + (startNode.measured?.height || 0) / 2,
			};

			let bestCandidate: Node | null = null;
			let bestScore = Infinity;

			// Evaluate every other node as a potential traversal target
			nodes.forEach((node: Node) => {
				if (node.id === startNode.id) return;

				const nodeCenter = {
					x: node.position.x + (node.measured?.width || 0) / 2,
					y: node.position.y + (node.measured?.height || 0) / 2,
				};

				// Signed deltas from current center to candidate center
				const dx = nodeCenter.x - currentCenter.x;
				const dy = nodeCenter.y - currentCenter.y;

				let score: number;

				// Score each candidate by Euclidean distance with a 2x penalty on
				// the perpendicular axis, so nodes roughly in line are preferred.
				switch (event.key) {
					case 'd': // right: only consider nodes with positive dx
						if (dx > 0) {
							score = Math.hypot(dx, dy * 2);
							if (score < bestScore) {
								bestScore = score;
								bestCandidate = node;
							}
						}
						break;
					case 'a': // left: only consider nodes with negative dx
						if (dx < 0) {
							score = Math.hypot(dx, dy * 2);
							if (score < bestScore) {
								bestScore = score;
								bestCandidate = node;
							}
						}
						break;
					case 's': // down: only consider nodes with positive dy
						if (dy > 0) {
							score = Math.hypot(dx * 2, dy);
							if (score < bestScore) {
								bestScore = score;
								bestCandidate = node;
							}
						}
						break;
					case 'w': // up: only consider nodes with negative dy
						if (dy < 0) {
							score = Math.hypot(dx * 2, dy);
							if (score < bestScore) {
								bestScore = score;
								bestCandidate = node;
							}
						}
						break;
				}
			});

			const candidate = bestCandidate as Node | null;
			if (candidate) {
				// Mark only the winning candidate as selected in the node array
				const updatedNodes = nodes.map((node: Node) => ({
					...node,
					selected: node.id === candidate.id,
				}));
				setNodes(updatedNodes);
				setSelectedNodes([candidate]);
				setSelectedNode(candidate.id);
				setSelectedNodeId(candidate.id);

				// Programmatically focus the DOM element so keyboard events continue from it
				const nodeElement = containerRef.current?.querySelector(
					`[data-id="${candidate.id}"]`
				);
				if (nodeElement instanceof HTMLElement) {
					nodeElement.focus();
				}
			}
		};

		const container = containerRef.current;
		if (container) {
			// Use capture phase so this handler fires before React Flow's default key handlers
			container.addEventListener('keydown', handleKeyDown, true);
		}

		return () => {
			if (container) {
				container.removeEventListener('keydown', handleKeyDown, true);
			}
		};

	}, [containerRef, wasdKeys, nodes, setNodes, setSelectedNode, selectedNode, setSelectedNodes, actionsPanelType, setSelectedNodeId]);
};
