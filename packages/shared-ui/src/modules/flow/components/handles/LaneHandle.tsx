// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Custom connection handle (port) for ReactFlow nodes.
 *
 * Wraps the base ReactFlow Handle with an inner styled Box that changes
 * its background and border color based on connection and disabled states.
 * Used on pipeline nodes to define data-lane (circular) connection points
 * on the left and right edges.
 *
 * All visual properties reference --rr-* CSS custom properties.
 */

import React, { CSSProperties, ReactElement, useMemo, useRef, useCallback } from 'react';
import { HandleProps, Handle as RFHandle } from '@xyflow/react';
import { Box } from '@mui/material';

import { handleStyles } from './styles';

/**
 * Props for the LaneHandle component, extending the base ReactFlow HandleProps.
 */
interface IHandleProps extends HandleProps {
	/** Whether this handle has an active edge connection. */
	isConnected?: boolean;
	/** When true, the handle is visually dimmed and non-interactive. */
	disabled?: boolean;
	/** Border/fill color for the handle when not connected. */
	color?: string;
	/** Additional inline CSS styles applied to the inner handle element. */
	style?: CSSProperties;
	/** Called when the handle is clicked (not dragged). */
	onClick?: (event: React.MouseEvent) => void;
}

/**
 * Renders a custom connection handle (port) on a ReactFlow node.
 *
 * Color priority: connected (accent) > default (hollow).
 */
export default function LaneHandle({ isConnected, disabled, color = 'var(--rr-border)', style, type, onClick, ...props }: IHandleProps): ReactElement {
	/** Dimmed styles applied when handle is disabled. */
	const disabledStyles: CSSProperties = useMemo(() => (disabled ? { pointerEvents: 'none' as const, opacity: 0.4 } : {}), [disabled]);

	/** Background: connected uses focus border (always opaque), hollow uses canvas bg. */
	const backgroundColor = isConnected ? 'var(--rr-border-focus)' : 'var(--rr-bg-paper)';

	/** Border: connected uses node border-focus color for visibility, default uses the color prop. */
	const borderColor = isConnected ? 'var(--rr-border-focus)' : color;

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
					pointerEvents: 'none',
					...disabledStyles,
					...style,
				}}
			/>
		</RFHandle>
	);
}
