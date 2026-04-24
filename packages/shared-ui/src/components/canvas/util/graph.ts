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
 * Graph construction utilities for the flow canvas.
 *
 * Responsible for converting between the serialised IProject model and the
 * INode graph representation used by the canvas. These are pure functions
 * with no side-effects — they take data in and return transformed data out.
 *
 * Key functions:
 *   - {@link getNodesFromProject} — Converts project components into INode[]
 *   - {@link getEdgesFromNodes}   — Derives edges from the connection arrays stored on each node
 *   - {@link generateNodeId}      — Produces a unique, human-readable node ID
 */

import { Edge } from '@xyflow/react';

import { uuid } from './uuid';
import { INodeType } from '../types';

import type { PipelineComponent } from 'rocketride';

import { IProject, IProjectComponent, INode, INodeData, IControlConnection, IInputConnection, INodeConfig } from '../types';

/**
 * Minimal node shape accepted by utility functions.
 * Compatible with both INode (type: string) and ReactFlow's Node (type?: string).
 */
type INodeLike = Pick<INode, 'id' | 'data'> & {
	type?: string;
	parentId?: string;
};

// ============================================================================
// Default edge template
// ============================================================================

/** Base properties applied to every edge created by getEdgesFromNodes. */
const DEFAULT_EDGE: Partial<Edge> = {
	selectable: true,
	deletable: true,
	zIndex: 5,
};

// ============================================================================
// Node ID generation
// ============================================================================

/**
 * Generates a unique, human-readable node ID by appending an incrementing
 * numeric suffix to the provider key.
 *
 * Walks the existing node list to find the first unused suffix, producing
 * IDs like "llm_openai_1", "llm_openai_2", etc.
 *
 * @param existingNodes - The current set of nodes to check for collisions.
 * @param provider      - The service provider key used as the ID prefix.
 * @returns A unique node ID string.
 *
 * @example
 * ```ts
 * const id = generateNodeId(nodes, 'llm_openai');
 * // => "llm_openai_1" (or "llm_openai_2" if _1 already exists)
 * ```
 */
export const generateNodeId = (existingNodes: { id: string }[] = [], provider: string): string => {
	let num = 1;
	let proposedId = `${provider}_${num}`;

	// Increment the suffix until we find an ID that isn't already in use
	while (existingNodes.some((node) => node.id === proposedId)) {
		num++;
		proposedId = `${provider}_${num}`;
	}

	return proposedId;
};

// ============================================================================
// Project → Nodes
// ============================================================================

/**
 * Converts a serialised IProject into an array of INode objects.
 *
 * Walks the component tree (including nested group children) and produces
 * a flat array of nodes. Each component's data is kept thin — only the
 * component's own fields (provider, name, config, connections) are stored
 * on the node. Service-level metadata (icon, lanes, classType) is looked
 * up at render time via the provider key.
 *
 * Handles legacy/template projects gracefully by backfilling missing `ui`
 * fields with sensible defaults.
 *
 * @param project        - The project containing the component tree to convert.
 * @param servicesJson   - The service catalog, keyed by provider name.
 * @returns A flat array of INode objects (groups and their children are at the same level).
 *
 * @example
 * ```ts
 * const nodes = getNodesFromProject(project, servicesJson);
 * const edges = getEdgesFromNodes(nodes);
 * ```
 */
export const getNodesFromProject = (project: IProject): INode[] => {
	const nodes: INode[] = [];

	/**
	 * Recursively traverses the component tree, creating an INode
	 * for each component and descending into group children.
	 *
	 * @param components - The components at the current level of the tree.
	 */
	const traverse = (components: PipelineComponent[] = []) => {
		for (const raw of components) {
			// -----------------------------------------------------------------
			// 1. Backfill missing UI metadata so legacy/template projects
			//    don't crash when loaded into the canvas.
			// -----------------------------------------------------------------
			const ui: IProjectComponent['ui'] = {
				position: { x: 0, y: 0 },
				measured: { width: 150, height: 36 },
				nodeType: INodeType.Default,
				formDataValid: true,
				...(raw.ui ?? {}),
			};
			const component: IProjectComponent = { ...raw, ui };

			// -----------------------------------------------------------------
			// 3. Determine the node ID. Use the persisted ID when available;
			//    otherwise generate a unique one from the provider key.
			// -----------------------------------------------------------------
			const id = component.id ?? generateNodeId(nodes, component.provider);

			// -----------------------------------------------------------------
			// 4. Build the thin INodeData from component fields only.
			//    Service-level metadata (icon, lanes, classType, invoke, etc.)
			//    will be looked up at render time via node.data.provider.
			// -----------------------------------------------------------------

			// Clone config, stripping any nested pipeline (group nodes store
			// child components inside config.pipeline)
			const config: INodeConfig = { ...component?.config };
			if (config?.pipeline) {
				delete config['pipeline'];
			}

			const data: INodeData = {
				provider: component.provider,
				name: component.name || '',
				description: component.description || '',
				config,
				formDataValid: component.ui.formDataValid !== false,
				input: component.input || [],
				control: component.control || [],
			};

			// -----------------------------------------------------------------
			// 5. Build the INode with position, dimensions, and type from
			//    the component's UI metadata.
			// -----------------------------------------------------------------
			const node: INode = {
				id,
				type: component.ui.nodeType || INodeType.Default,
				position: component.ui.position,
				data,
				measured: component.ui.measured,
				parentId: component.ui.parentId,
				deletable: true,
				selectable: true,
			};

			// Note: extent:'parent' intentionally omitted so nodes can be dragged out of groups

			nodes.push(node);

			// -----------------------------------------------------------------
			// 6. If this component is a group, recurse into its nested children.
			// -----------------------------------------------------------------
			const configObj = component.config as { pipeline?: { components?: IProjectComponent[] } };
			if (configObj?.pipeline?.components?.length) {
				traverse(configObj.pipeline.components);
			}
		}
	};

	// Start traversal from the top-level components
	traverse(project?.components);

	return nodes;
};

// ============================================================================
// Nodes → Edges
// ============================================================================

/**
 * Derives ReactFlow edges from the connection arrays stored on each node.
 *
 * Rather than persisting edges separately (which can drift out of sync),
 * edges are computed from two arrays on each node's data:
 *
 *   - `control` — Invoke/control-flow edges (diamond handles).
 *     Each entry produces an edge from `control.from` → this node,
 *     using `invoke-source.{classType}` / `invoke-target` handles.
 *
 *   - `input` — Data-lane edges (circular handles).
 *     Each entry produces an edge from `input.from` → this node,
 *     using `source-{lane}` / `target-{lane}` handles.
 *
 * @param nodes - The INode array whose connection data should be read.
 * @returns An array of edges with unique IDs, ready for ReactFlow.
 *
 * @example
 * ```ts
 * const nodes = getNodesFromProject(project, servicesJson);
 * const edges = getEdgesFromNodes(nodes);
 * // => [Edge, Edge, ...]
 * ```
 */
export const getEdgesFromNodes = (nodes: INodeLike[]): Edge[] => {
	const edges: Edge[] = [];

	for (const node of nodes) {
		const { data } = node;

		// -----------------------------------------------------------------
		// Build invoke-type edges from control connections (trigger/control flow).
		// These connect diamond-shaped handles between nodes.
		// -----------------------------------------------------------------
		if (data.control?.length) {
			data.control.forEach((control: IControlConnection) => {
				edges.push({
					...DEFAULT_EDGE,
					id: uuid(),
					source: control.from,
					target: node.id,
					sourceHandle: `invoke-source.${control.classType}`,
					targetHandle: 'invoke-target',
				});
			});
		}

		// -----------------------------------------------------------------
		// Build lane-type edges from input connections (data flow).
		// These connect circular handles between nodes.
		// -----------------------------------------------------------------
		if (data.input?.length) {
			data.input.forEach((input: IInputConnection) => {
				edges.push({
					...DEFAULT_EDGE,
					id: uuid(),
					source: input.from,
					target: node.id,
					sourceHandle: `source-${input.lane}`,
					targetHandle: `target-${input.lane}`,
				});
			});
		}
	}

	return edges;
};

// ============================================================================
// Node → Component (for server validation)
// ============================================================================

/**
 * Converts a single INode back into an IProjectComponent suitable for
 * server-side validation or persistence.
 *
 * This is the inverse of what getNodesFromProject does — it takes the
 * thin INodeData and the node's position/dimensions and rebuilds the
 * serialised component format the server expects.
 *
 * @param node - The canvas node to convert.
 * @returns The serialised component representation.
 */
export const getComponentFromNode = (node: INode): IProjectComponent => {
	const { data } = node;

	// Build the base component with UI metadata
	const component: IProjectComponent = {
		id: node.id,
		provider: data.provider || 'default',
		...(data.name ? { name: data.name } : {}),
		...(data.description ? { description: data.description } : {}),
		config: data.config ?? {},
		ui: {
			position: { x: node.position.x, y: node.position.y },
			nodeType: (node.type as INodeType) ?? INodeType.Default,
			formDataValid: data.formDataValid !== false,
			parentId: node.parentId,
		},
	};

	// Attach connection arrays only when non-empty
	if (data.control?.length) {
		component.control = data.control;
	}
	if (data.input?.length) {
		component.input = data.input;
	}

	return component;
};

// ============================================================================
// Child & Project Component Builders
// ============================================================================

/**
 * Returns the transformed components whose parentId matches the given parent.
 *
 * - Pass `undefined` to get root-level components (nodes with no parent).
 * - Pass a group node's ID to get that group's direct children.
 *
 * Does NOT recurse — returns only one level of children.
 *
 * @param allNodes - All nodes currently on the canvas.
 * @param parentId - The parent group ID to filter by, or undefined for root.
 * @returns Components at the requested level.
 */
export const getChildComponents = (allNodes: INode[], parentId?: string): IProjectComponent[] => {
	return allNodes.filter((node) => node.parentId === parentId).map(getComponentFromNode);
};

/**
 * Rebuilds the full project component tree from a flat list of canvas nodes.
 *
 * Starts at the root level (no parentId) and recursively nests children
 * inside their parent group's `config.pipeline.components`.
 *
 * @param allNodes - All nodes currently on the canvas.
 * @returns The top-level component array with groups containing nested children.
 */
export const getProjectComponents = (allNodes: INode[]): IProjectComponent[] => {
	/**
	 * Gets components at a given level and recursively nests
	 * children into any group nodes found.
	 */
	const buildLevel = (parentId?: string): IProjectComponent[] => {
		const components = getChildComponents(allNodes, parentId);

		// For each group node, recurse into its children
		for (const component of components) {
			if (component.ui?.nodeType === INodeType.Group) {
				const children = buildLevel(component.id);
				if (children.length > 0) {
					component.config = {
						...component.config,
						pipeline: { components: children },
					};
				}
			}
		}

		return components;
	};

	// Start from root level (no parent)
	return buildLevel(undefined);
};
