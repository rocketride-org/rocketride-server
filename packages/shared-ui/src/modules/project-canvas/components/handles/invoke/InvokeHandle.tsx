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
import { Box, useTheme } from '@mui/material';
import pxToRem from '../../../../../utils/pxToRem';
import { handleStyles } from '../../styles';
import { brandOrange } from '../../../../../theme';
import { isInVSCode } from '../../../../../utils/vscode';

const inVSCode = isInVSCode();

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
	selected,
	...props
}: IProps): ReactElement {
	const theme = useTheme();

	// When disabled, remove interactivity and reduce visual prominence
	const disabledStyles: CSSProperties = useMemo(() => (disabled ? {
		pointerEvents: 'none' as const,
		opacity: 0.4,
	} : {}), [disabled]);

	// Match the data handle color logic: selected > connected > default
	const accentColor = inVSCode ? 'var(--vscode-button-background)' : brandOrange;
	const connectedColor = inVSCode
		? 'var(--vscode-button-background)'
		: theme.palette.text.primary;

	const backgroundColor = useMemo(() => {
		if (selected) return accentColor;
		if (isConnected) return connectedColor;
		return theme.palette.background.default;
	}, [selected, isConnected, theme, accentColor, connectedColor]);

	const borderColor = useMemo(() => {
		if (selected) return accentColor;
		if (isConnected) return connectedColor;
		return '#56565A';
	}, [selected, isConnected, accentColor, connectedColor]);

	return (
		<div style={{ position: 'relative', margin: '0 20px' }}>
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
						width: `${pxToRem(12)}rem`,
						height: `${pxToRem(12)}rem`,
						border: `1px solid ${borderColor}`,
						background: backgroundColor,
						borderRadius: '2px',
						transform: 'rotate(45deg)',
						pointerEvents: 'none',
						...disabledStyles,
						...style,
					}}
				/>
			</RFHandle>
		</div>
	);
}
