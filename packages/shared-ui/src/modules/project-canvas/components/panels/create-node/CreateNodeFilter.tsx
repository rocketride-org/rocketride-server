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

import { ReactNode } from 'react';
import Chip from '@mui/material/Chip';

/**
 * Props for the CreateNodeFilter chip component.
 * Represents a single active filter that narrows the visible node list
 * in the CreateNodePanel.
 */
export interface IProps {
	/** Display text for the filter chip (e.g. "Input: text"). */
	label: string;
	/** Background color of the chip, typically the brand orange. */
	color: string;
	/** Callback invoked when the user clicks the chip's delete icon. */
	onDelete: () => void;
}

/**
 * Renders a dismissible MUI Chip that represents an active data-type
 * filter in the "Add Node" panel. Filters are created when the user
 * clicks a handle on an existing node, restricting the node list to
 * compatible pipe types.
 *
 * @param label - Text displayed on the chip.
 * @param color - Chip background color.
 * @param onDelete - Handler to remove this filter.
 */
export default function CreateNodeFilter({ label, color, onDelete }: IProps): ReactNode {
	return (
		<Chip
			sx={{
				background: color,
				color: '#fff',
				fontWeight: '500',
				padding: '2px 4px',
				'& .MuiChip-deleteIcon': {
					marginLeft: '2px',
					marginRight: '2px',
					fontSize: '16px',
				},
			}}
			label={label}
			onDelete={() => onDelete()}
		/>
	);
}
