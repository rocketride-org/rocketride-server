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

import React, { CSSProperties, ReactElement, useMemo, useRef, useCallback } from 'react';
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
	/** Called when the handle is clicked (not dragged). */
	onClick?: (event: React.MouseEvent) => void;
}

/**
 * Renders a diamond-shaped invoke handle on a canvas node.
 *
 * Color priority: connected (accent) > default (hollow).
 */
export default function InvokeHandle({ isConnected, disabled, type, style, invokeType, onClick, ...props }: IInvokeHandleProps): ReactElement {
	/** Dimmed styles applied when handle is disabled. */
	const disabledStyles: CSSProperties = useMemo(() => (disabled ? { pointerEvents: 'none' as const, opacity: 0.4 } : {}), [disabled]);

	/** Background: connected uses focus border (always opaque), hollow uses canvas bg. */
	const backgroundColor = isConnected ? 'var(--rr-border-focus)' : 'var(--rr-bg-paper)';

	/** Border: connected uses node border-focus color for visibility, default uses border. */
	const borderColor = isConnected ? 'var(--rr-border-focus)' : 'var(--rr-border)';

	// Distinguish click from drag — only fire onClick if mouse didn't move
	const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

	const onMouseDown = useCallback((e: React.MouseEvent) => {
		mouseDownPos.current = { x: e.clientX, y: e.clientY };
	}, []);

	const onMouseUp = useCallback(
		(e: React.MouseEvent) => {
			if (!onClick || !mouseDownPos.current) return;
			const dx = Math.abs(e.clientX - mouseDownPos.current.x);
			const dy = Math.abs(e.clientY - mouseDownPos.current.y);
			// If mouse moved less than 10px, treat as click — not a drag
			if (dx < 10 && dy < 10) {
				e.stopPropagation();
				onClick(e);
				// Cancel ReactFlow's in-progress connection drag by dispatching
				// a synthetic mouseup on the document
				document.dispatchEvent(
					new MouseEvent('mouseup', {
						bubbles: true,
						clientX: e.clientX,
						clientY: e.clientY,
					})
				);
			}
			mouseDownPos.current = null;
		},
		[onClick]
	);

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
				onMouseDown={onMouseDown}
				onMouseUp={onMouseUp}
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
