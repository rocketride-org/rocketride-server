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

import { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, useMemo } from 'react';
import { HandleProps, Handle as RFHandle } from '@xyflow/react';
import { Box, Typography, useTheme } from '@mui/material';

/**
 * Props for the InvokeHandle component.
 *
 * Extends ReactFlow HandleProps with additional visual state flags and an
 * optional invoke-type label to distinguish between different invocation channels.
 */
interface IProps extends HandleProps {
	/** Whether this handle currently has an edge connected to it. */
	isConnected?: boolean;
	/** When true the handle is rendered with reduced opacity and ignores pointer events. */
	disabled?: boolean;
	/** Label displayed below the handle indicating the invocation type (e.g. class name). */
	invokeType?: string;
	/** Additional inline CSS applied to the diamond-shaped inner element. */
	style?: CSSProperties;
	/** Whether this handle is currently selected by the user. */
	selected?: boolean;
	/** Click handler forwarded to the wrapper div. */
	onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/**
 * Diamond-shaped handle used for invoke (method-call) connections on canvas nodes.
 *
 * Unlike the standard circular data-flow handles, InvokeHandle renders as a small
 * rotated square (diamond) to visually distinguish invocation edges from data edges.
 * It displays an optional type label beneath the handle and adapts its fill color
 * based on connection state and the current theme.
 *
 * @param props - Handle configuration including connection state, type label, and styling.
 * @returns The rendered invoke handle element.
 */
export default function InvokeHandle({
	isConnected,
	disabled,
	type,
	invokeType,
	style,
	...props
}: IProps): ReactElement {
	const theme = useTheme();

	// When disabled, remove interactivity and reduce visual prominence
	/** Conditional styles that grey out the handle when disabled. */
	const disabledStyles = useMemo(() => (disabled ? {
		pointerEvents: 'none' as const,
		opacity: 0.4,
	} : {}), [disabled]);

	// Derive colors from the theme so the handle adapts to light/dark mode
	const handleBorderColor = theme.palette.text.secondary;
	// Fill the diamond when connected to give a clear visual indicator of active edges
	const handleBgColor = isConnected
		? theme.palette.text.secondary
		: theme.palette.background.paper;

	// Build the diamond shape: zero border-radius + 45-degree rotation on a small square
	const _style = {
		...style,
		width: '6px',
		height: '6px',
		borderRadius: '0',
		border: `1.5px solid ${handleBorderColor}`,
		backgroundColor: handleBgColor,
		transform: 'rotate(45deg)',
	};

	return (
		// Horizontal margin keeps adjacent invoke handles from touching each other
		<div style={{ position: 'relative', margin: '0 20px' }}>
			{/* Render the invocation type label below the diamond when provided */}
			{invokeType && (
				<Typography
					component="span"
					sx={{
						pointerEvents: 'none',
						position: 'absolute',
						display: 'flex',
						justifyContent: 'center',
						fontSize: '0.5rem',
						color: 'text.secondary',
						bottom: '4px',
						left: '-4px',
						right: 0,
					}}
				>
					{invokeType}
				</Typography>
			)}
			{/* The RFHandle is transparent and oversized to provide a larger click target;
			    the visible diamond is the inner Box which has pointerEvents disabled to
			    let the parent handle capture all interactions. */}
			<RFHandle
				{...props}
				type={type}
				style={{
					width: '8px',
					height: '8px',
					border: 'none',
					background: 'transparent',
					display: 'flex',
					justifyContent: 'center',
					alignItems: 'center',
				}}
			>
				<Box
					style={{
						..._style,
						...disabledStyles,
						pointerEvents: 'none',
					}}
				/>
			</RFHandle>
		</div>
	);
}
