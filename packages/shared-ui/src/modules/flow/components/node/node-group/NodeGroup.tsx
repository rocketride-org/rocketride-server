// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * NodeGroup — Component for group nodes on the flow canvas.
 *
 * Visually matches a regular node (top cap, header, bottom cap) but is
 * resizable and contains a drop area for child nodes in the middle.
 */

import { ReactElement, memo } from 'react';
import { NodeResizer, useStore, useNodeId } from '@xyflow/react';
import { Box } from '@mui/material';

import { INodeData } from '../../../types';
import NodeHeader from '../node-component/header';

/**
 * Props passed by ReactFlow for registered node type components.
 */
interface INodeGroupProps {
	id: string;
	data: INodeData;
	type?: string;
	parentId?: string;
}

/**
 * Renders a group node that looks like a regular node but is resizable,
 * with a drop area between the header and the bottom cap for child nodes.
 */
function NodeGroup({ id, data, type, parentId }: INodeGroupProps): ReactElement {
	const nodeId = useNodeId();
	const selected = useStore((s) => s.nodeLookup?.get(nodeId ?? '')?.selected ?? false);

	return (
		<Box sx={styles.root}>
			<NodeResizer minWidth={200} minHeight={100} isVisible={selected} lineStyle={{ borderWidth: 1, borderColor: 'var(--rr-accent)' }} color="var(--rr-accent)" />

			{/* Top corner cap — matches header titlebar */}
			<Box sx={styles.cornerCapTop} />

			{/* Header — icon, title, gear, overflow menu */}
			<NodeHeader id={id} title={data.name || 'Group'} nodeType={type} hideEdit={false} formDataValid={data.formDataValid} description={data.description} parentId={parentId} />

			{/* Drop area for child nodes */}
			<Box sx={styles.body} />

			{/* Bottom corner cap */}
			<Box sx={styles.cornerCapBottom} />
		</Box>
	);
}

export default memo(NodeGroup);

// =============================================================================
// Styles
// =============================================================================

const styles = {
	/** Root wrapper — flex column filling the full node dimensions. */
	root: {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
	},

	/** Top cap — rounded top, titlebar color. */
	cornerCapTop: {
		height: '8px',
		borderRadius: '4px 4px 0 0',
		backgroundColor: 'var(--rr-bg-titleBar-inactive)',
		'.react-flow__node:hover &, .react-flow__node.selected &': {
			backgroundColor: 'var(--rr-bg-titleBar-active)',
		},
	},

	/** Middle body — white drop area that fills remaining space. */
	body: {
		flex: 1,
		backgroundColor: 'var(--rr-bg-paper)',
	},

	/** Bottom cap — rounded bottom, white to match body. */
	cornerCapBottom: {
		height: '4px',
		borderRadius: '0 0 4px 4px',
		backgroundColor: 'var(--rr-bg-paper)',
	},
};
