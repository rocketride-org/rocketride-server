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
 * Factory functions for creating ReactFlow node instances.
 *
 * Each factory produces a fully-configured `Node` object with the correct type,
 * default styles, and initial data.  They are the single point of construction
 * for all canvas nodes, ensuring consistent defaults and parent-child setup.
 */
import { Node } from '@xyflow/react';
import { NodeType, NodeData, NodePosition, NodeMeasured } from './constants';
import { styles as nodeStyles } from './components/nodes/node/index.style';
import { removeUndefined } from '../../utils/remove-undefined';

/**
 * Creates a standard pipeline node (connector/service) on the canvas.
 *
 * If `data` is provided it is merged onto the node, and the factory determines
 * whether the node's form data is valid based on the presence of a Pipe schema.
 * When a `parentId` is supplied the node is constrained within its parent group.
 *
 * @param id - Unique node identifier.
 * @param position - Initial canvas coordinates.
 * @param data - Optional service definition and form data to attach.
 * @param parentId - Optional parent group node ID.
 * @returns A configured ReactFlow `Node`.
 */
export function createNode(
	id: string,
	position: NodePosition = { x: 0, y: 0 },
	data?: NodeData,
	parentId?: string
): Node<NodeData> {
	// Build the base node with default metadata; formDataValid starts false
	// because the user hasn't configured anything yet.
	const node: Node = {
		id,
		type: NodeType.Default,
		deletable: true,
		selectable: true,
		style: nodeStyles.flowRoot,
		position,
		data: {
			type: NodeType.Default,
			class: NodeType.Default,
			formDataValid: false,
		},
	};

	if (data) {
		// Strip undefined values so they don't clobber existing defaults during spread
		const _data = removeUndefined(data);
		const pipe = _data.Pipe as { schema?: { properties?: Record<string, unknown> } } | undefined;
		// A node is considered "schema-bearing" only if it has non-hidden properties;
		// schema-less nodes (e.g. group placeholders) are always valid.
		const hasSchema =
			pipe?.schema?.properties?.hideForm == undefined &&
			pipe?.schema?.properties != undefined;
		const formDataValid = hasSchema ? (_data.formDataValid ?? false) : true;
		node.data = { ...node.data, ..._data, formDataValid };
	}

	if (parentId) {
		// Constrain this node within its parent group boundaries
		node.parentId = parentId;
		node.extent = 'parent';
	}

	return node;
}

/** Default width and height (px) for newly created annotation nodes. */
export const AnnotationNodeDefaultDimensions = {
	width: 250,
	height: 150,
};

/**
 * Creates an annotation (sticky-note) node on the canvas.
 *
 * Annotation nodes are free-form text blocks that users can place alongside
 * pipeline connectors for documentation purposes.  They do not participate
 * in data flow or pipeline execution.
 *
 * @param id - Unique node identifier.
 * @param position - Initial canvas coordinates.
 * @param data - Optional data (e.g. saved text content) to attach.
 * @param measured - Width/height dimensions for the annotation container.
 * @param parentId - Optional parent group node ID.
 * @returns A configured ReactFlow `Node` of type Annotation.
 */
export function createAnnotationNode(
	id: string,
	position: NodePosition = { x: 0, y: 0 },
	data?: NodeData,
	measured: NodeMeasured = AnnotationNodeDefaultDimensions,
	parentId?: string
): Node<NodeData> {
	// Annotations don't participate in pipeline execution, so no formDataValid needed
	const node: Node = {
		id,
		type: NodeType.Annotation,
		selectable: true,
		deletable: true,
		draggable: true,
		style: {
			// Make the ReactFlow wrapper transparent so all visuals come from the inner component;
			// suppress ReactFlow's default selection border/outline
			background: 'transparent',
			border: 'none',
			outline: 'none',
			padding: 0,
		},
		position,
		width: measured.width,
		height: measured.height,
		data: {
			type: NodeType.Annotation,
			class: NodeType.Annotation,
		},
	};

	if (data) {
		// Spread order: caller data first, then node.data, so type/class always wins
		node.data = { ...data, ...node.data };
	}

	if (parentId) {
		// Constrain annotation inside its parent group
		node.parentId = parentId;
		node.extent = 'parent';
	}

	return node;
}

/** Default width and height (px) for newly created group nodes. */
export const GroupNodeDefaultDimensions = {
	width: 380,
	height: 200,
};

/**
 * Creates a remote-group node representing a remote execution context.
 *
 * Remote group nodes visually contain child connector nodes that execute
 * on a remote agent. They have explicit dimensions and are rendered with
 * a distinct visual style.
 *
 * @param id - Unique node identifier.
 * @param position - Initial canvas coordinates.
 * @param data - Optional data to attach.
 * @param measured - Width/height dimensions for the group container.
 * @param parentId - Optional parent group node ID.
 * @returns A configured ReactFlow `Node` of type RemoteGroup.
 */
export function createRemoteGroupNode(
	id: string,
	position: NodePosition = { x: 0, y: 0 },
	data?: NodeData,
	measured: NodeMeasured = GroupNodeDefaultDimensions,
	parentId?: string
): Node<NodeData> {
	// Remote groups have explicit dimensions because child nodes are positioned relative to them
	const node: Node = {
		id,
		type: NodeType.RemoteGroup,
		selectable: true,
		deletable: true,
		draggable: true,
		style: {},
		position,
		width: measured.width,
		height: measured.height,
		data: {
			type: NodeType.RemoteGroup,
			class: NodeType.RemoteGroup,
		},
		parentId,
	};

	if (data) {
		// Merge caller data but let the node-type metadata take precedence
		node.data = { ...data, ...node.data };
	}

	if (parentId) {
		// Nest this remote group inside another group if specified
		node.parentId = parentId;
		node.extent = 'parent';
	}

	return node;
}

/**
 * Creates a local group node used to visually cluster selected nodes.
 *
 * Group nodes are created via Cmd/Ctrl+G and lock their children in place
 * by default (isLocked=true).  They render with a transparent background
 * and elevated z-index so children are always visible.
 *
 * @param id - Unique node identifier.
 * @param position - Initial canvas coordinates.
 * @param data - Optional data to attach.
 * @param measured - Width/height dimensions for the group container.
 * @param parentId - Optional parent group node ID.
 * @returns A configured ReactFlow `Node` of type Group.
 */
export function createGroupNode(
	id: string,
	position: NodePosition = { x: 0, y: 0 },
	data?: NodeData,
	measured: NodeMeasured = GroupNodeDefaultDimensions,
	parentId?: string
): Node<NodeData> {
	// Local groups are transparent containers; high zIndex keeps children visible above edges
	const node: Node = {
		id,
		type: NodeType.Group,
		selectable: true,
		deletable: true,
		draggable: true,
		style: {
			background: 'none',
			border: 'none',
			zIndex: 1001,
		},
		position,
		width: measured.width,
		height: measured.height,
		data: {
			type: NodeType.Group,
			class: NodeType.Group,
			// Groups start locked so children can't be dragged out accidentally
			isLocked: true,
		},
		parentId,
	};

	if (data) {
		// Merge caller data but let type/class/isLocked defaults take precedence
		node.data = { ...data, ...node.data };
	}

	if (parentId) {
		// Nest this group inside another parent group
		node.parentId = parentId;
		node.extent = 'parent';
	}

	return node;
}
