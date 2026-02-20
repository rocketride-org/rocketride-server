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

import { ReactElement, ReactNode, useState, useEffect } from 'react';
import { Box, SimplePaletteColorOptions, SxProps } from '@mui/material';
import { theme } from '../../../theme';
import { Panel, PanelPosition } from '@xyflow/react';

/**
 * Props for the NotifyBar component.
 * Configures the appearance, content, and behavior of a notification bar
 * displayed as a floating panel on the canvas.
 */
interface IProps {
	/** Color palette used for the bar border and icon tint. Defaults to the info palette. */
	palette?: SimplePaletteColorOptions;
	/** Optional icon rendered on the left side of the notification. */
	icon?: ReactNode;
	/** Content to display inside the notification bar. */
	children?: ReactNode;
	/** Additional MUI sx styles applied to the root Box element. */
	rootSx?: SxProps;
	/** Position of the floating panel on the ReactFlow canvas. Defaults to 'bottom-center'. */
	panelPosition?: PanelPosition;
	/** When true, the bar automatically fades out and hides after a set duration. */
	fadeOut?: boolean;
}

/** Duration in milliseconds that the notification bar remains fully visible before fading. */
const VISIBILITY_DURATION = 5000;

/** Duration in milliseconds for the fade-out animation. */
const FADE_DURATION = 500;

/**
 * Renders a floating notification bar on the ReactFlow canvas panel.
 * Used to display status messages (e.g., install progress, errors, completions)
 * with an optional icon and configurable color palette. Supports an automatic
 * fade-out behavior for transient notifications.
 *
 * @param props - Configuration for the notification bar content and appearance.
 * @returns The rendered notification bar, or null after fade-out completes.
 */
export default function NotifyBar({
	palette = theme.palette.info,
	icon,
	children,
	rootSx,
	panelPosition = 'bottom-center',
	fadeOut = false,
}: IProps): ReactElement {
	// Track whether the bar should be rendered at all
	const [visible, setVisible] = useState(true);
	// Track whether the fade-out CSS transition is active (opacity -> 0)
	const [fading, setFading] = useState(false);

	useEffect(() => {
		// Skip fade-out setup for persistent notifications
		if (!fadeOut) {
			return;
		}

		// After VISIBILITY_DURATION, begin the CSS opacity transition
		const fadeTimer = setTimeout(() => setFading(true), VISIBILITY_DURATION);
		// After the transition finishes, remove the element from the DOM entirely
		const removeTimer = setTimeout(
			() => setVisible(false),
			VISIBILITY_DURATION + FADE_DURATION
		);

		// Cleanup both timers on unmount or when fadeOut prop changes
		return () => {
			clearTimeout(fadeTimer);
			clearTimeout(removeTimer);
		};
	}, [fadeOut]);

	// Once hidden, render nothing (cast needed because return type is ReactElement)
	if (!visible) {
		return null as unknown as ReactElement;
	}

	return (
		<Panel position={panelPosition}>
			<Box
				sx={{
					...rootSx,
					border: `1px solid ${palette.main}`,
					backgroundColor: '#fff',
					color: palette.main,
					borderRadius: '6px',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'flex-start',
					padding: '0.5rem 0.75rem',
					transition: 'opacity 0.5s ease',
					opacity: 1,
					...(fading ? { opacity: 0 } : {}),
				}}
			>
				<Box
					sx={{
						display: 'flex',
						alignItems: 'center',
						marginRight: '0.75rem',
					}}
				>
					{icon}
				</Box>
				<Box>{children}</Box>
			</Box>
		</Panel>
	);
}
