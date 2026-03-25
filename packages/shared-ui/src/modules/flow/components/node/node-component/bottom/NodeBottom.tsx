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
 * NodeBottom — Bottom corner cap and invoke source diamond handles.
 *
 * Renders two things:
 *   1. A 4px rounded corner cap at the bottom of the node body. Its background
 *      color is passed in as `bottomCapBg` so it matches the last visible
 *      section above it (lanes, status, or tools).
 *   2. Diamond-shaped InvokeHandle components positioned on the bottom edge
 *      (only when the node has invoke sources like LLM, Memory, Tool).
 *      These handles initiate outgoing invoke (control-flow) connections.
 */

import { ReactElement } from 'react';
import { Box } from '@mui/material';
import { Edge, Position } from '@xyflow/react';
import { InvokeHandle } from '../../../handles';
import ConditionalRender from '../../../ConditionalRender';

/**
 * Props for the NodeBottom component.
 */
interface INodeBottomProps {
	/** Unique node ID, used to match edges. */
	id: string;
	/** Invoke source channel keys (e.g. ["llm", "memory", "tool"]). Empty array = no invoke sources. */
	invokeSourceKeys: string[];
	/** All edges in the flow, used to determine which handles are connected. */
	edges: Edge[];
	/** Background color for the bottom corner cap — must match the last visible section above. */
	bottomCapBg: string;
}

/** Style for the 4px rounded bottom corner cap. */
const cornerCapBottom = {
	height: '4px',
	borderRadius: '0 0 4px 4px',
};

/**
 * Renders the bottom corner cap and optional invoke source diamond handles.
 *
 * @param props - Node identity, invoke sources, edge state, cap color, and validation.
 * @returns The corner cap element, optionally followed by positioned invoke source handles.
 */
export default function NodeBottom({ id, invokeSourceKeys, edges, bottomCapBg }: INodeBottomProps): ReactElement {
	return (
		<>
			{/* Bottom corner cap — color matches the last visible section */}
			<Box sx={{ ...cornerCapBottom, backgroundColor: bottomCapBg }} />

			{/* Invoke source diamond handles — outside the node, labels inside each handle */}
			<ConditionalRender condition={invokeSourceKeys.length > 0}>
				<Box
					sx={{
						position: 'absolute',
						bottom: 0,
						left: 0,
						right: 0,
						display: 'flex',
						justifyContent: 'center',
						transform: 'translateY(50%)',
						zIndex: 1,
					}}
				>
					{invokeSourceKeys.map((key: string) => (
						<InvokeHandle key={key} id={`invoke-source.${key}`} type="source" position={Position.Bottom} invokeType={key} isConnected={edges.some((edge: Edge) => edge.sourceHandle === `invoke-source.${key}` && edge.source === id)} />
					))}
				</Box>
			</ConditionalRender>
		</>
	);
}
