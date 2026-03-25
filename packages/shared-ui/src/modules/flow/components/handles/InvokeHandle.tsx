// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Diamond-shaped handle for invoke (control-flow) connections.
 *
 * Unlike the standard circular data-flow handles, InvokeHandle renders
 * as a rotated square (diamond) to visually distinguish invocation edges
 * from data edges. Positioned on the top and bottom edges of nodes that
 * support the Invoke capability.
 *
 * All visual properties reference --rr-* CSS custom properties.
 */

import { CSSProperties, ReactElement, useMemo } from 'react';
import { HandleProps, Handle as RFHandle } from '@xyflow/react';
import { Box, Typography } from '@mui/material';

import { handleStyles } from './styles';

/**
 * Props for the InvokeHandle component.
 */
interface IInvokeHandleProps extends HandleProps {
	/** Whether this handle currently has an edge connected to it. */
	isConnected?: boolean;
	/** When true the handle is rendered with reduced opacity and ignores pointer events. */
	disabled?: boolean;
	/** Additional inline CSS applied to the diamond-shaped inner element. */
	style?: CSSProperties;
	/** Label displayed above the diamond (e.g. "LLM", "Memory"). Only used on source handles. */
	invokeType?: string;
}

/**
 * Renders a diamond-shaped invoke handle on a canvas node.
 *
 * Color priority: connected (accent) > default (hollow).
 */
export default function InvokeHandle({ isConnected, disabled, type, style, invokeType, ...props }: IInvokeHandleProps): ReactElement {
	/** Dimmed styles applied when handle is disabled. */
	const disabledStyles: CSSProperties = useMemo(() => (disabled ? { pointerEvents: 'none' as const, opacity: 0.4 } : {}), [disabled]);

	/** Background: connected uses focus border (always opaque), hollow uses canvas bg. */
	const backgroundColor = isConnected ? 'var(--rr-border-focus)' : 'var(--rr-bg-paper)';

	/** Border: connected uses node border-focus color for visibility, default uses border. */
	const borderColor = isConnected ? 'var(--rr-border-focus)' : 'var(--rr-border)';

	return (
		<div style={{ position: 'relative', margin: '0 20px' }}>
			{invokeType && (
				<Typography
					variant="caption"
					sx={{
						position: 'absolute',
						bottom: '100%',
						left: '50%',
						transform: 'translateX(-50%)',
						fontSize: 'var(--rr-font-size-xs)',
						lineHeight: 1,
						color: 'var(--rr-text-disabled)',
						paddingBottom: '3px',
						marginBottom: '6px',
						pointerEvents: 'none',
						userSelect: 'none',
						whiteSpace: 'nowrap',
					}}
				>
					{invokeType === 'llm' ? 'LLM' : invokeType.charAt(0).toUpperCase() + invokeType.slice(1)}
				</Typography>
			)}
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
						width: '8px',
						height: '8px',
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
