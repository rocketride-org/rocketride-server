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

import { CSSProperties, ReactElement, useMemo } from 'react';
import { HandleProps, Handle as RFHandle } from '@xyflow/react';
import { Box, useTheme } from '@mui/material';

import pxToRem from '../../../utils/pxToRem';

import { handleStyles } from './styles';
import { brandOrange } from '../../../theme';
import { isInVSCode } from '../../../utils/vscode';

const inVSCode = isInVSCode();

/**
 * Props for the Handle component, extending the base ReactFlow HandleProps.
 * Adds visual state indicators for selection, connection, and disabled states.
 */
interface IProps extends HandleProps {
	/** Whether the parent node is currently selected, highlighting the handle. */
	selected?: boolean;
	/** Whether this handle has an active edge connection. */
	isConnected?: boolean;
	/** When true, the handle is visually dimmed and non-interactive. */
	disabled?: boolean;
	/** Border/fill color for the handle when not connected or selected. */
	color?: string;
	/** Additional inline CSS styles applied to the inner handle element. */
	style?: CSSProperties;
}

/**
 * Renders a custom connection handle (port) on a ReactFlow node.
 * Wraps the base ReactFlow Handle with an inner styled Box that changes
 * its background and border color based on selection, connection, and
 * disabled states. Used on pipeline nodes to define input/output connection points.
 *
 * @param props - Handle configuration including visual state and base ReactFlow handle props.
 * @returns The rendered custom handle element.
 */
export default function Handle({
	isConnected,
	disabled,
	color = '#56565A',
	style,
	type,
	selected,
	...props
}: IProps): ReactElement {
	const theme = useTheme();
	// Compute disabled styles separately to avoid re-creating the full style object on every render
	/** Computed inline styles that dim the handle and disable pointer events when the handle is disabled. */
	const disabledStyles: CSSProperties = useMemo(
		() =>
			disabled
				? {
						pointerEvents: 'none' as const,
						opacity: 0.4,
					}
				: {},
		[disabled]
	);

	// Background and border colors follow a priority: selected > connected > default
	/** Accent color: VS Code button color or brand orange for standalone. */
	const accentColor = inVSCode ? 'var(--vscode-button-background)' : brandOrange;

	/** Connected fill: uses VS Code button background for a cohesive look. */
	const connectedColor = inVSCode
		? 'var(--vscode-button-background)'
		: theme.palette.text.primary;

	/** Computes the handle background color based on selection and connection state. */
	const backgroundColor = useMemo(() => {
		if (selected) {
			return accentColor;
		}
		if (isConnected) {
			return connectedColor;
		}
		// Hollow appearance: match the canvas background so the handle looks empty
		return theme.palette.background.default;
	}, [selected, isConnected, theme, accentColor, connectedColor]);

	/** Computes the handle border color based on selection and connection state. */
	const borderColor = useMemo(() => {
		if (selected) {
			return accentColor;
		}
		if (isConnected) {
			return connectedColor;
		}
		// Fall back to the color prop (typically a neutral grey)
		return color;
	}, [selected, isConnected, color, theme, accentColor, connectedColor]);

	return (
		<RFHandle
			{...props}
			type={type}
			style={{
				...handleStyles,
				display: 'flex',
				justifyContent: 'center',
				alignItems: 'center',
			}}
		>
			<Box
				style={{
					width: `${pxToRem(8)}rem`,
					height: `${pxToRem(8)}rem`,
					border: `1px solid ${borderColor}`,
					borderColor: borderColor,
					background: backgroundColor,
					borderRadius: '2px',
					pointerEvents: 'none',
					...disabledStyles,
					...style,
				}}
			/>
		</RFHandle>
	);
}
