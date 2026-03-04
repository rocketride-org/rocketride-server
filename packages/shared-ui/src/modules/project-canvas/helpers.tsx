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
 * Pure helper/utility functions for the project canvas module.
 *
 * Responsible for:
 * - Normalising legacy project structures.
 * - Converting between the ReactFlow JSON graph and the serialised IProject model.
 * - Computing edges from node connection arrays (single source of truth).
 * - Lane display helpers and HTML sanitisation utilities.
 * - Calculating default node positions on the viewport.
 * - Determining required subscription plans for a pipeline.
 */
import { ReactNode } from 'react';
import { Edge, Node, ReactFlowJsonObject } from '@xyflow/react';
import DOMPurify from 'dompurify';
import parse, { DOMNode, Element as DOMElement, domToReact, HTMLReactParserOptions } from 'html-react-parser';
import i18next from 'i18next';

import { uuid } from '../../utils/uuid';
import { getIconPath } from '../../utils/get-icon-path';
import { IDynamicForms } from '../../services/dynamic-forms/types';
import { DEFAULT_ZOOM, defaultEdge, NodeType } from './constants';
import {
	createAnnotationNode,
	createRemoteGroupNode,
	createNode,
	createGroupNode,
	GroupNodeDefaultDimensions,
} from './factories';
import { IControl, IInputLane, INodeData, IProject, IProjectComponent, LaneObject } from './types';

/**
 * Generates an ID for a new component based on a class type
 *
 * @param {Node[]} nodes
 * @param {string} componentClass
 *
 * @return {string} - The ID for the component.
 */
export const generateId = (nodes: Node[] = [], componentProvider: string): string => {
	// Increment a numeric suffix until a unique ID is found (e.g. "http_1", "http_2", ...)
	let num = 1;
	let proposedId = `${componentProvider}_${num}`;

	while (nodes.some((node) => node.id === proposedId)) {
		num++;
		proposedId = `${componentProvider}_${num}`;
	}

	return proposedId;
};

/**
 * Transforms a ReactFlow node into a project component
 * @param {ReactFlowJsonObject} object - Not used anymore, kept for compatibility
 * @param {Node} node
 * @return {IProjectComponent} - The project component.
 */
export const transformNodeToComponent = (
	object: ReactFlowJsonObject,
	node: Node
): IProjectComponent => {
	const nd = node.data as INodeData;

	// Build the base component with UI metadata for position, size, and visual type
	let component: IProjectComponent = {
		id: node.id,
		provider: (nd.provider || 'default') as string,
		...(nd.name ? { name: nd.name } : {}),
		...(nd.description ? { description: nd.description } : {}),
		config: nd?.formData ?? {},
		ui: {
			position: {
				x: node.position.x,
				y: node.position.y,
			},
			measured: {
				// Use measured dimensions if available, otherwise fall back to reasonable defaults
				width: node.measured?.width || 150,
				height: node.measured?.height || 36,
			},
			data: {
				provider: (nd.provider || 'default') as string,
				class: nd.class as string,
				type: nd.type as NodeType,
				content: nd.content as string,
				fgColor: nd.fgColor as string,
				bgColor: nd.bgColor as string,
			},
			parentId: node.parentId,
			formDataValid: nd.formDataValid === false ? false : true,
		},
	};

	// Get input and controlConnections directly from node.data (single source of truth)
	const input = nd?.input || [];
	const control = nd?.controlConnections || [];

	// Only attach control/input arrays when non-empty; remote group nodes don't use them
	if (control.length) {
		component = { ...component, control };
	}

	if (input.length) {
		component = { ...component, input };
	}

	return component;
};

/**
 * Creates a PID_PROJECTS property to store in DB from a ReactFlow object
 *
 * @param {ReactFlowJsonObject} object
 * @param {string} name
 *
 * @return {IProject} - The PID_PROJECTS property to be stored in DB.
 */
export const objectToProperty = (
	object: ReactFlowJsonObject,
	name?: string,
	description?: string,
	version?: number
): IProject => {
	// Clone nodes to prevent mutation on the original ReactFlow objects
	const nodes = object.nodes.map((n: Node) => ({ ...n }));

	// Partition nodes into top-level (no parent) and children (nested inside a group)
	const parentNodes: Node[] = [];
	const childNodes: Node[] = [];

	for (const node of nodes) {
		if (node.parentId == null) parentNodes.push(node);
		else if (node.parentId != null) childNodes.push(node);
	}

	// Build a lookup from parent ID -> array of child nodes for fast tree traversal
	const remoteComponents = new Map<string, Node[]>();

	for (const node of childNodes) {
		if (!node.parentId) throw new Error('Invalid parentId');
		const _nodes = [...(remoteComponents.get(node.parentId) ?? []), node];
		remoteComponents.set(node.parentId, _nodes);
	}

	// Recursively convert a node and its children into an IProjectComponent tree
	const traverse = (node: Node): IProjectComponent => {
		let component = transformNodeToComponent(object, node);

		// If this node has children, nest them inside config.pipeline.components
		const childNodes = remoteComponents.get(node.id) ?? [];
		let _components = null;
		if (childNodes.length) {
			_components = childNodes.map((n: Node) => traverse(n));
		}
		const pipeline = { components: _components };

		// Only embed the pipeline sub-object when there are actual child components
		if (pipeline?.components?.length) {
			component = {
				...component,
				config: {
					...component.config,
					pipeline,
				},
			};
		}

		return component;
	};

	// Convert all top-level nodes (each may recursively contain children)
	const components: IProjectComponent[] = parentNodes.map((n: Node) => traverse(n));

	return {
		viewport: object.viewport,
		version,
		name: name || '',
		description: description || '',
		components: components,
	};
};

/**
 * Creates a ReactFlow object from a PID_PROJECTS property
 *
 * @param {IProject} property
 * @param {IDynamicForms} servicesJson
 *
 * @return {ReactFlowJsonObject} - The ReactFlow JSON object.
 */
export const propertyToObject = (
	property: IProject,
	servicesJson: IDynamicForms
): ReactFlowJsonObject => {
	const nodes: Node[] = [];

	// Recursively walk the component tree and produce ReactFlow Node objects
	const traverse = (components: IProjectComponent[] = []) => {
		for (const component of components) {
			// Look up the service definition to enrich the node with schema, icon, lanes, etc.
			const serviceObject = servicesJson[component.provider];

			// Backfill missing UI metadata so legacy/template projects don't crash
			if (!component.ui) {
				component.ui = {} as IProjectComponent['ui'];
			}

			if (!component.ui.position) {
				component.ui.position = { x: 0, y: 0 };
			}

			if (!component.ui.measured) {
				component.ui.measured = { width: 150, height: 36 };
			}

			if (!component.ui.data) {
				// Derive visual class from the service definition when UI data is absent
				component.ui.data = {
					class: (serviceObject?.classType as unknown as string) || 'default',
					type: NodeType.Default,
					content: '',
					provider: component.id || '',
				};
			}

			if (component.ui.formDataValid === undefined) {
				component.ui.formDataValid = true;
			}

			// Use the persisted ID when available; otherwise generate a unique one
			const id = component.id ?? generateId(nodes, component.provider);

			const { position, measured } = component.ui;

			// Clone config into formData, stripping nested pipeline (handled separately below)
			const formData = { ...component?.config };

			// Group nodes store child components inside config.pipeline; remove it from formData
			if (formData?.pipeline) {
				delete formData['pipeline'];
			}

			// Merge service-level metadata (schema, lanes, icon) with component-level config
			const data = {
				provider: component.provider,
				class: component.ui.data.class,
				type: component.ui.data.type,
				content: component.ui.data.content,
				fgColor: component.ui.data.fgColor,
				bgColor: component.ui.data.bgColor,
				formData,
				name: component.name || '',
				description: component.description || '',
				icon: getIconPath(serviceObject?.icon),
				classType: serviceObject?.classType,
				capabilities: serviceObject?.capabilities,
				lanes: serviceObject?.lanes,
				control: serviceObject?.control,
				Pipe: serviceObject?.Pipe,
				invoke: serviceObject?.invoke,
				tile: serviceObject?.tile,
				documentation: serviceObject?.documentation,
				formDataValid: component.ui?.formDataValid === false ? false : true,
				// Store input and control connections as single source of truth
				input: component.input || [],
				controlConnections: component.control || [],
			};

			// Dispatch to the correct factory based on the persisted node type
			if (component.ui.data.type === NodeType.Annotation) {
				const node = createAnnotationNode(id, position, data, measured, component.ui.parentId);
				nodes.push(node);
			} else if (component.ui.data.type === NodeType.Default) {
				const node = createNode(id, position, data, component.ui.parentId);
				nodes.push(node);
			} else if (component.ui.data.type === NodeType.RemoteGroup) {
				const node = createRemoteGroupNode(
					id,
					position,
					data,
					measured,
					component.ui.parentId
				);
				nodes.push(node);
			} else if (component.ui.data.type === NodeType.Group) {
				const node = createGroupNode(id, position, data, measured, component.ui.parentId);
				nodes.push(node);
			}

			// If this component is a group, recurse into its nested child components
			const configObj = component.config as { pipeline?: { components?: IProjectComponent[] } };
			if (configObj?.pipeline?.components?.length) {
				traverse(configObj.pipeline.components);
			}
		}
	};

	// Start traversal from the top-level components
	traverse(property?.components);

	// Derive edges from nodes' input/control arrays rather than storing them separately
	const computedEdges = computeEdgesFromNodes(nodes);

	return {
		nodes: nodes,
		edges: computedEdges,
		// Fall back to a centred default viewport when the project has none saved
		viewport: property.viewport || {
			x: 0,
			y: 0,
			zoom: DEFAULT_ZOOM,
		},
	};
};

/**
 * Computes edges from nodes' input and control arrays (single source of truth)
 *
 * @param {Node[]} nodes - Array of ReactFlow nodes
 * @return {Edge[]} - Array of computed edges
 */
export const computeEdgesFromNodes = (nodes: Node[]): Edge[] => {
	const edges: Edge[] = [];

	for (const node of nodes) {
		const nd = node.data as INodeData;

		// Build invoke-type edges from controlConnections (trigger/control flow)
		if (nd?.controlConnections?.length) {
			nd.controlConnections.forEach((control: IControl) => {
				edges.push({
					...defaultEdge,
					id: uuid(),
					source: control.from,
					target: node.id,
					sourceHandle: 'invoke-source',
					targetHandle: `invoke-target-${control.classType}`,
				});
			});
		}

		// Build lane-type edges from input connections (data flow between services)
		if (nd?.input?.length) {
			nd.input.forEach((input: IInputLane) => {
				edges.push({
					...defaultEdge,
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

/**
 * Filter, remove duplicates and sort lanes
 *
 * @param {Lane} lanes
 */

/**
 * A lane descriptor is either a plain string lane name or a structured {@link LaneObject}.
 * Used for both input and output lane arrays in service definitions.
 */
export type Lane = (string | LaneObject)[];

/**
 * Sorts an array of output lanes alphabetically by their type string.
 * Used to render lane handles in a deterministic order on each node.
 *
 * @param lanes - The unsorted lane array.
 * @returns A new sorted array (does not mutate the original).
 */
export const sortOutputLanes = (lanes: Lane) => {
	// Clone the array to avoid mutating the original, then sort by the lane type string
	return [...lanes].sort((a, b) => {
		// Normalise: plain strings use themselves as the sort key; objects use their .type
		const aValue = typeof a === 'string' ? a : a.type;
		const bValue = typeof b === 'string' ? b : b.type;
		if (aValue < bValue) return -1;
		if (aValue > bValue) return 1;
		return 0;
	});
};

/**
 * Get the display values for an output lane
 *
 * @param {Lane} lanes
 * @return {type, required, sourceId, label}
 */
export const getOutputLaneDisplayValues = (outputLane: string | LaneObject) => {
	let type = '';
	let required = false;
	let sourceId = '';
	let label = '';

	if (typeof outputLane === 'string') {
		// Simple string lane: derive display label from the lane name
		type = outputLane;
		sourceId = `source-${type}`;
		label = renameLanes(type);
	} else {
		// Structured lane object: extract type and check if a minimum connection count is required
		type = outputLane.type;
		required = outputLane.min ? outputLane.min >= 1 : false;
		sourceId = `source-${type}`;
	}

	return {
		type,
		required,
		sourceId,
		label,
	};
};

/**
 * Sanitize and parse string that contains HTML into a ReactNode
 *
 * @param {text} string
 * @return {ReactNode}
 */
export const sanitizeAndParseHtmlToReact = (text?: string): string | ReactNode => {
	if (!text) return text;

	let _text: string | ReactNode = text;

	// Only run the expensive sanitize+parse path when the string actually contains HTML tags
	if (/<\/?[a-z][\s\S]*>/i.test(_text as string)) {
		// Sanitize HTML to prevent XSS while preserving target/rel for external links
		const sanitized = DOMPurify.sanitize(_text as string, {
			ADD_ATTR: ['target', 'rel'],
		});

		// Replace <a> tags so they always open in a new tab with safe rel attributes
		const options: HTMLReactParserOptions = {
			replace: (domNode: DOMNode) => {
				const el = domNode as DOMElement;
				if (el.name === 'a' && el.attribs?.href) {
					const { href, ...rest } = el.attribs;

					return (
						<a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
							{el.children ? (parse(domToReact(el.children as DOMNode[]) as string)) : null}
						</a>
					);
				}
			},
		};

		_text = parse(sanitized, options);
	}

	return _text;
};

/**
 * Rename a lane label if necessary
 *
 * @param {originalLaneName} string
 * @return {string}
 */
export const renameLanes = (originalLaneName = '') => {
	// Map internal lane identifiers to user-friendly localised labels
	switch (originalLaneName) {
		case 'tags': {
			// "tags" is displayed as "Data" in the UI for clarity
			return i18next.t('flow.laneMapping.data');
		}
		default: {
			return originalLaneName;
		}
	}
};

/**
 * Get the default position for a new node on the canvas
 *
 * @param {NodeType} nodeType
 * @param {Node[]} nodes
 * @param {React.RefObject<HTMLElement>} canvasRef
 * @param {(position: { x: number; y: number }) => { x: number; y: number }} screenToFlowPosition
 * @return {NodePosition}
 */
export const getDefaultNodePosition = (
	nodeType: NodeType,
	canvasRef: React.RefObject<HTMLElement>,
	nodes: Node[],
	screenToFlowPosition: (position: { x: number; y: number }) => {
		x: number;
		y: number;
	}
): { x: number; y: number } => {
	// Can't compute a meaningful position without a mounted canvas element
	if (canvasRef?.current == null) return { x: 0, y: 0 };
	const { width, height } = canvasRef.current.getBoundingClientRect();

	// Offset each new node slightly (8px per existing node) to avoid perfect overlap
	let centerX = (width - 400) / 2 + nodes.length * 8;
	let centerY = height / 2 + nodes.length * 8;

	// Remote group nodes are larger, so shift the origin to centre them visually
	if (nodeType === NodeType.RemoteGroup) {
		centerX -= GroupNodeDefaultDimensions.width / 2;
		centerY -= GroupNodeDefaultDimensions.height / 2;
	}

	// Convert screen pixel coordinates to the ReactFlow coordinate system
	const position = screenToFlowPosition({
		x: centerX,
		y: centerY,
	});

	return position;
};

/**
 * Get the position of a node inside its parent group node
 *
 * @param {node} Partial<Node>
 * @param {groupNode} Node
 * @return {NodePosition}
 */
export const getNodePositionInsideParent = (node: Partial<Node>, groupNode: Node) => {
	const position = node.position ?? { x: 0, y: 0 };
	const nodeWidth = node.measured?.width ?? 0;
	const nodeHeight = node.measured?.height ?? 0;
	const groupWidth = groupNode.measured?.width ?? 0;
	const groupHeight = groupNode.measured?.height ?? 0;

	// Clamp X: if the node overflows to the left, pin it to 0;
	// if it overflows to the right, pin it to the right edge; otherwise convert to parent-relative
	if (position.x < groupNode.position.x) {
		position.x = 0;
	} else if (position.x + nodeWidth > groupNode.position.x + groupWidth) {
		position.x = groupWidth - nodeWidth;
	} else {
		position.x = position.x - groupNode.position.x;
	}

	// Clamp Y using the same overflow logic as X
	if (position.y < groupNode.position.y) {
		position.y = 0;
	} else if (position.y + nodeHeight > groupNode.position.y + groupHeight) {
		position.y = groupHeight - nodeHeight;
	} else {
		position.y = position.y - groupNode.position.y;
	}

	return position;
};

/**
 * Get the required plan for a pipeline
 */
export function getRequiredPlanForPipeline(
	source: string,
	components: IProjectComponent[],
	servicesJson: Record<string, unknown>
): Map<string, string[]> {
	// Build lookup maps: component by ID, and parent -> children via input lanes
	const nodes = new Map<string, IProjectComponent>();
	const nodeChildren = new Map<string, string[]>();

	for (const component of components ?? []) {
		nodes.set(component.id, component);

		// Each input lane's "from" field points to a predecessor; register this node as its child
		for (const lane of component.input ?? []) {
			const children = nodeChildren.get(lane.from) ?? [];
			children.push(component.id);
			nodeChildren.set(lane.from, children);
		}
	}

	// BFS starting from the source node, collecting plan requirements for every reachable node
	const requiredPlans = new Map<string, string[]>();
	const seen = new Set();

	let sources: string[] = [source];
	while (sources.length) {
		const node = nodes.get(sources.pop() as string);
		if (!node) continue;

		// Skip already-visited nodes to avoid infinite loops in cyclic graphs
		if (seen.has(node.id)) continue;

		// Look up the service definition to read its required subscription plans
		const def = servicesJson[node.provider] as { plans?: string[] } | undefined;
		if (!def) continue;

		requiredPlans.set(node.provider, def.plans ?? []);

		// Enqueue downstream nodes for processing
		sources = [...sources, ...(nodeChildren.get(node.id) ?? [])];
		seen.add(node.id);
	}

	return requiredPlans;
}
