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
 * useAutoLayout — Provides an ELK-based auto-layout function for the flow canvas.
 *
 * Uses elkjs to compute a layered (Sugiyama-style) layout that respects
 * parent/child (group) relationships. Nodes are repositioned in-place and
 * edges are rebuilt from the updated node connection data.
 *
 * The layout runs asynchronously in a web worker (elkjs default) so it
 * does not block the main thread.
 */

import { useCallback, useState } from 'react';
import { Node, Edge, useReactFlow } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled';
import type { ElkNode } from 'elkjs';

import { INodeType } from '../types';
import type { INodeData } from '../types';

/** ReactFlow Node with strongly-typed data. Matches FlowGraphContext's FlowNode. */
type FlowNode = Node<INodeData>;

// ============================================================================
// ELK instance (shared across calls, stateless)
// ============================================================================

const elk = new ELK();

// ============================================================================
// Constants
// ============================================================================

/** Horizontal gap between sibling nodes. */
const NODE_SPACING = 60;

/** Vertical gap between layers. */
const LAYER_SPACING = 80;

/** Padding inside group nodes around their children. */
const GROUP_PADDING = 40;

// ============================================================================
// Hook
// ============================================================================

interface UseAutoLayoutReturn {
	/** Runs ELK layout on the current nodes and edges. */
	autoLayout: () => Promise<void>;
	/** True while a layout computation is in progress. */
	isLayouting: boolean;
}

/**
 * Returns a function that applies an ELK layered layout to the current
 * ReactFlow graph, preserving group/child relationships.
 *
 * @param nodes    - Current canvas nodes.
 * @param edges    - Current canvas edges.
 * @param setNodes - ReactFlow node setter.
 * @param onContentUpdated - Callback to mark the project as dirty.
 */
export function useAutoLayout(nodes: FlowNode[], edges: Edge[], setNodes: React.Dispatch<React.SetStateAction<FlowNode[]>>, onContentUpdated: () => void): UseAutoLayoutReturn {
	const [isLayouting, setIsLayouting] = useState(false);
	const { fitView } = useReactFlow();

	const autoLayout = useCallback(async () => {
		if (nodes.length === 0) return;

		setIsLayouting(true);

		try {
			// -----------------------------------------------------------------
			// 1. Build the ELK graph, nesting children inside their parent groups.
			// -----------------------------------------------------------------

			/** Lookup: nodeId → ElkNode reference (so we can attach children). */
			const elkNodeMap = new Map<string, ElkNode>();

			// Create an ElkNode for every canvas node
			for (const node of nodes) {
				const width = node.measured?.width ?? node.width ?? 150;
				const height = node.measured?.height ?? node.height ?? 50;

				const elkNode: ElkNode = {
					id: node.id,
					width,
					height,
					// Groups will have their children attached below
					children: [],
					// Carry layout options for groups
					layoutOptions:
						node.type === INodeType.Group
							? {
									'elk.padding': `[top=${GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
									'elk.algorithm': 'layered',
									'elk.direction': 'RIGHT',
									'elk.spacing.nodeNode': String(NODE_SPACING),
									'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_SPACING),
								}
							: undefined,
				};

				elkNodeMap.set(node.id, elkNode);
			}

			// Nest children inside their parent group ElkNode
			const rootChildren: ElkNode[] = [];

			for (const node of nodes) {
				const elkNode = elkNodeMap.get(node.id)!;

				if (node.parentId) {
					const parent = elkNodeMap.get(node.parentId);
					if (parent) {
						parent.children!.push(elkNode);
						continue;
					}
				}
				rootChildren.push(elkNode);
			}

			// Build ELK edges (only edges between nodes at the same level)
			const elkEdges = edges.map((edge) => ({
				id: edge.id,
				sources: [edge.source],
				targets: [edge.target],
			}));

			const elkGraph: ElkNode = {
				id: 'root',
				children: rootChildren,
				edges: elkEdges,
				layoutOptions: {
					'elk.algorithm': 'layered',
					'elk.direction': 'RIGHT',
					'elk.spacing.nodeNode': String(NODE_SPACING),
					'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_SPACING),
					'elk.edgeRouting': 'ORTHOGONAL',
				},
			};

			// -----------------------------------------------------------------
			// 2. Run the ELK layout
			// -----------------------------------------------------------------

			const layoutResult = await elk.layout(elkGraph);

			// -----------------------------------------------------------------
			// 3. Apply the computed positions back to the ReactFlow nodes.
			// -----------------------------------------------------------------

			/** Recursively collects positioned nodes from the ELK result. */
			const positionMap = new Map<string, { x: number; y: number }>();

			const collectPositions = (elkNode: ElkNode) => {
				if (elkNode.id !== 'root') {
					positionMap.set(elkNode.id, {
						x: elkNode.x ?? 0,
						y: elkNode.y ?? 0,
					});
				}
				for (const child of elkNode.children ?? []) {
					collectPositions(child);
				}
			};
			collectPositions(layoutResult);

			setNodes((nds) =>
				nds.map((node) => {
					const pos = positionMap.get(node.id);
					if (!pos) return node;
					return {
						...node,
						position: pos,
					};
				})
			);

			onContentUpdated();

			// Fit the viewport to the new layout after React commits
			requestAnimationFrame(() => {
				fitView({ padding: 0.15, duration: 300 });
			});
		} finally {
			setIsLayouting(false);
		}
	}, [nodes, edges, setNodes, onContentUpdated, fitView]);

	return { autoLayout, isLayouting };
}
