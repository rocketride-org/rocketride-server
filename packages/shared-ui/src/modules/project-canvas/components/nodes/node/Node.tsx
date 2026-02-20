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

import { ReactElement, useMemo } from 'react';
import { Box } from '@mui/material';
import { Node as NodeProps } from '@xyflow/react';

import { styles } from './index.style';
import { useFlow } from '../../../FlowContext';
import { Lane } from '../../../helpers';
import { INodeData, NodeLayout } from '../../../types';
import { NodeType } from '../../../../../constants';
import Lanes from '../../lanes/Lanes';
import RunButton from '../../run-button/RunButton';
import ProjectNodeHeader from '../../node-header/ProjectNodeHeader';
import NodeFooter from '../../node-footer';

/**
 * Props for the generic canvas Node wrapper component.
 * Extends React Flow's NodeProps with application-specific fields like
 * node data, layout direction, and an optional click handler.
 */
interface IProps extends NodeProps {
	id: string;
	data: INodeData;
	children: ReactElement;
	type: NodeType;
	layout?: NodeLayout;
	handleClick?: () => void;
	parentId?: string;
}

/**
 * Generic pipeline node component that renders the standard node chrome
 * on the project canvas: header with icon/title, data lanes (input/output
 * handles), a run button for source nodes, and a footer with provider info.
 * All concrete node types (e.g. LLM, Database, Filter) delegate to this
 * component for their shared visual structure.
 *
 * @param id - Unique node identifier within the flow.
 * @param data - Typed node data containing title, icon, lanes, form state, etc.
 * @param children - Additional content rendered inside the header area.
 * @param parentId - ID of the parent group node, if any.
 * @param type - Discriminated node type enum value.
 * @param layout - Lane layout direction; defaults to 'horizontal'.
 * @param handleClick - Optional click handler forwarded to the node header.
 */
export default function Node({
	id,
	data,
	children,
	parentId,
	type,
	layout = 'horizontal',
	handleClick,
}: IProps): ReactElement {
	// Destructure the rich node data bag into individual rendering props
	const {
		name,
		description,
		lanes,
		icon,
		classType,
		formDataValid,
		provider,
		documentation,
		Pipe,
	} = data;

	const { nodes, taskStatuses, componentPipeCounts, totalPipes, servicesJson } = useFlow();

	// Look up service catalog title and description from the provider
	const serviceInfo = (servicesJson as Record<string, { title?: string; description?: string }> | undefined)?.[provider as string];
	const displayTitle = name || serviceInfo?.title;
	const displayDescription = description || serviceInfo?.description;

	/**
	 * Resolves the most recent parent ID for this node by looking it up
	 * in the current nodes array. This is necessary because the parentId
	 * prop may be stale after group operations (e.g. ungroup/regroup).
	 */
	const mostRecentParentId = useMemo(() => {
		// If no parent, pass through as-is (undefined)
		if (!parentId) {
			return parentId;
		}
		// Look up the node from the live nodes array to get its current parentId
		const thisNode = nodes.find((n: NodeProps) => n.id === id);

		return thisNode?.parentId;
	}, [nodes, parentId, id]);

	// Always show the edit button since every node has a Details panel
	// for name and description, even if there is no RJSF configuration form.
	const showEditButton = true;

	/** Whether this node is classified as a source node, which renders a run button. */
	const isSourceNode = useMemo(() => classType?.includes('source') || false, [classType]);

	/** Task status for this node (id must match backend status_update source). Updated when host receives status_update and merges into taskStatuses. */
	const taskStatus = taskStatuses?.[id];

	return (
		<Box key={id} sx={styles.nodeContent}>
			{isSourceNode && <RunButton nodeId={id} />}
			<Box sx={styles.headerWrapper}>
				<ProjectNodeHeader
					id={id}
					icon={icon}
					title={displayTitle}
					handleClick={handleClick}
					nodeType={type}
					hideEdit={!showEditButton}
					formDataValid={formDataValid}
					description={displayDescription}
					documentation={documentation}
					parentId={mostRecentParentId}
				/>
				{children}
			</Box>
			<Lanes nodeId={id} lanes={lanes as Record<string, Lane>} layout={layout} data={data} />
			<NodeFooter
				componentProvider={provider ?? ''}
				isSourceNode={isSourceNode}
				taskStatus={taskStatus}
				componentPipeCounts={componentPipeCounts}
				totalPipes={totalPipes}
			/>
		</Box>
	);
}
