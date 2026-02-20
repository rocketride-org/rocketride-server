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
import { Badge, IconButton, Tooltip, SxProps } from '@mui/material';
import { History } from '@mui/icons-material';
import { grey } from '@mui/material/colors';
import { useTranslation } from 'react-i18next';

import { useFlow } from '../FlowContext';

/**
 * Props for the OpenLogsButton component.
 * Allows customization of the badge, icon button, and icon styles.
 */
interface IProps {
	/** Optional style overrides for the badge, icon button, and icon elements. */
	styles?: {
		badge?: SxProps;
		iconButton?: SxProps;
		icon?: SxProps;
	};
}

/**
 * Renders a button that opens the pipeline execution log history panel.
 * Displays a pulsing badge indicator when the pipeline is currently running.
 * Used in the canvas controls toolbar to give users quick access to logs.
 *
 * @param props - Optional style overrides for the button sub-elements.
 * @returns The rendered logs button with a badge and tooltip.
 */
export default function OpenLogsButton({ styles }: IProps): ReactElement {
	const { t } = useTranslation();
	const flow = useFlow() as { onOpenLogHistory?: () => void; toolchainState?: { isRunning: boolean } };
	const { onOpenLogHistory, toolchainState } = flow;

	return (
		<Badge
			color="primary"
			variant="dot"
			invisible={!toolchainState?.isRunning}
			slotProps={{
				badge: {
					className: 'pulse',
				},
			}}
			sx={{ ...styles?.badge }}
			onClick={() => onOpenLogHistory?.()}
		>
			<Tooltip title={t('flow.tooltip.logs')}>
				<IconButton sx={{ ...styles?.iconButton }}>
					<History
						sx={{
							color: grey[700],
							width: 'auto',
							height: '2rem',
							...styles?.icon,
						}}
					/>
				</IconButton>
			</Tooltip>
		</Badge>
	);
}
