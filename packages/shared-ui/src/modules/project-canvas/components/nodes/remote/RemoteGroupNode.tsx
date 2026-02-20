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

import { ReactElement } from 'react';
import { Node as NodeProps, NodeResizer } from '@xyflow/react';
import { Box } from '@mui/material';
import { useFlow } from '../../../FlowContext';
import NodeControls from '../../node-controls/NodeControls';
import { NodeType } from '../../../../../constants';
import NodeHeader from '../../node-header/ProjectNodeHeader';
import { INodeData } from '../../../types';

/**
 * Props for the RemoteGroupNode component, extending React Flow node props
 * with application-specific fields for remote group rendering.
 */
interface IProps extends NodeProps {
	id: string;
	type: NodeType;
	data: INodeData;
	parentId?: string;
	selected: boolean;
	handleClick?: () => void;
}

/**
 * Renders a remote group node on the project canvas. Remote group nodes
 * represent pipeline segments that execute on a remote machine. They are
 * visually distinct from local group nodes, featuring a translucent orange
 * overlay and glow effect when selected or hovered. The node is resizable
 * and includes the standard node header with edit capabilities.
 *
 * @param id - Unique node identifier within the flow.
 * @param type - Discriminated node type enum value.
 * @param data - Typed node data containing title, icon, and Pipe schema.
 * @param parentId - Optional parent group node id.
 * @param selected - Whether this node is currently selected.
 * @param handleClick - Optional click handler forwarded to the node header.
 */
export default function RemoteGroupNode({
	id,
	type,
	data,
	parentId,
	selected,
	handleClick,
}: IProps): ReactElement {
	const { selectedNodeId, hoveredGroupNodeId, servicesJson } = useFlow();
	const { name, description, icon, formDataValid } = data;

	// Look up service catalog title and description from the provider
	const serviceInfo = (servicesJson as Record<string, { title?: string; description?: string }> | undefined)?.[data.provider as string];
	const displayTitle = name || serviceInfo?.title;
	const displayDescription = description || serviceInfo?.description;

	/**
	 * Always show the edit button since every node has a Details panel
	 * for name and description, even if there are no configurable properties.
	 */
	const showEditButton = true;

	// Derive hover/selection state from flow context rather than relying solely on props,
	// since React Flow selection state can lag behind context updates
	const hovered = id === hoveredGroupNodeId;
	selected = id === selectedNodeId;

	// Translucent orange background distinguishes remote nodes from local ones;
	// glow effect applied when selected or hovered for visual feedback
	const sx = {
		position: 'relative',
		background: `rgba(247, 144, 31, 0.3)`,
		width: '100%',
		height: '100%',
		boxShadow: selected || hovered ? '0px 0px 10px 5px rgba(243, 158, 63, 0.8)' : '',
		backdropFilter: 'blur(1.5px)',
	};

	return (
		<>
			<NodeControls nodeId={id} nodeType={type} parentId={parentId} />
			<NodeResizer minWidth={200} minHeight={120} />
			<Box sx={sx}>
				<Box
					sx={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
					}}
				>
					<NodeHeader
						id={id}
						icon={icon}
						title={displayTitle}
						description={displayDescription}
						formDataValid={formDataValid}
						handleClick={handleClick}
						nodeType={type}
						hideEdit={!showEditButton}
					/>
				</Box>
			</Box>
		</>
	);
}
