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
import { useTranslation } from 'react-i18next';
import { Grid2 as Grid } from '@mui/material';
import { Engineering } from '@mui/icons-material';
import ReactJson from 'react-json-view';

import { IBasePanelProps } from '../types';
import BasePanel from '../BasePanel';
import BasePanelContent from '../BasePanelContent';
import BasePanelHeader from '../BasePanelHeader';

import { useFlow } from '../../../FlowContext';

/**
 * Renders a developer/debug panel on the project canvas that displays
 * the raw JSON representation of the current pipeline's components.
 * This panel is intended for development and troubleshooting, allowing
 * engineers to inspect the internal data structures of the pipeline.
 *
 * @param onClose - Callback to dismiss the panel.
 */
export default function DevPanel({ onClose }: IBasePanelProps): ReactNode {
	const { t } = useTranslation();
	const { currentProject } = useFlow();

	return (
		<BasePanel width={600}>
			<BasePanelHeader
				title={t('toolchainDevDrawer.title')}
				icon={<Engineering sx={{ mr: '1rem' }} />}
				onClose={onClose}
			/>
			<BasePanelContent>
				<Grid container sx={{ w: 1, p: 1 }}>
					<ReactJson
						src={{
							components: currentProject?.components,
						}}
					/>
				</Grid>
			</BasePanelContent>
		</BasePanel>
	);
}
