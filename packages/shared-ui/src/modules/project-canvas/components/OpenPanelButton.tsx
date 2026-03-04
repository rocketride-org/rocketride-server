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

import { ReactElement } from 'react';
import { Panel } from '@xyflow/react';
import { Button, Tooltip } from '@mui/material';
import { Add } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';

/**
 * Props for the OpenPanelButton component.
 */
interface IProps {
	/** Callback invoked when the button is clicked, typically to open the create-node panel. */
	handleClick: () => void;
}

/**
 * Renders a floating "add" button positioned at the bottom-right of the ReactFlow canvas.
 * When clicked, it opens the node creation panel so users can add new nodes to the pipeline.
 *
 * @param props - Contains the click handler to open the panel.
 * @returns The rendered floating action button with a tooltip.
 */
export default function OpenPanelButton({ handleClick }: IProps): ReactElement {
	const { t } = useTranslation();
	return (
		<Panel position="bottom-right">
			<Tooltip title={t('flow.tooltip.addNode')} placement="left">
				<Button
					variant="contained"
					size="large"
					color="primary"
					onClick={handleClick}
					sx={{ borderRadius: 1, height: 60, width: 60 }}
				>
					<Add />
				</Button>
			</Tooltip>
		</Panel>
	);
}
