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

import { ReactNode, useState, useCallback, useEffect } from 'react';
import { Paper, Box } from '@mui/material';
import { Panel } from '@xyflow/react';

/** Default width matching typical VSCode sidebar (e.g. CONNECTION MANAGER / PIPELINES). */
export const DEFAULT_SIDEBAR_WIDTH = 260;

/**
 * Props for the BasePanel container component.
 * Controls the panel's width, visibility, and optional drag-to-resize behavior.
 */
export interface IProps {
	/** Fixed width in pixels (ignored when `resizable` is true). */
	width?: number;
	children?: ReactNode;
	/** Whether the panel is rendered visibly; when false it is hidden via CSS. */
	visible?: boolean;
	/** Optional HTML `id` attribute applied to the inner Paper element. */
	id?: string;
	/** When true, panel width can be dragged; use defaultWidth for initial width. */
	resizable?: boolean;
	/** Initial width when resizable (defaults to DEFAULT_SIDEBAR_WIDTH when resizable). */
	defaultWidth?: number;
	/** Minimum width constraint during drag-to-resize. */
	minWidth?: number;
	/** Maximum width constraint during drag-to-resize. */
	maxWidth?: number;
}

/**
 * Base container for all side panels on the project canvas.
 * Renders a right-aligned panel overlay with an optional drag handle
 * for resizing. All concrete panels (CreateNodePanel, NodePanel, etc.)
 * wrap their content in this component to obtain consistent positioning,
 * sizing, and resize behavior.
 *
 * @param width - Fixed pixel width (used when resizable is false).
 * @param children - Panel content (header + body).
 * @param visible - Toggle panel visibility without unmounting.
 * @param id - HTML id for the inner Paper element.
 * @param resizable - Enable drag-to-resize via a left-edge handle.
 * @param defaultWidth - Starting width when resizable.
 * @param minWidth - Minimum allowed width during resize.
 * @param maxWidth - Maximum allowed width during resize.
 */
export default function BasePanel({
	width = 400,
	children,
	visible = true,
	id,
	resizable = false,
	defaultWidth,
	minWidth = 200,
	maxWidth = 800,
}: IProps): ReactNode {
	// Initialize width: when resizable, use the provided default or the standard sidebar width
	const [resizeWidth, setResizeWidth] = useState<number>(
		resizable ? (defaultWidth ?? DEFAULT_SIDEBAR_WIDTH) : width
	);
	const [isResizing, setIsResizing] = useState(false);
	// Capture the starting mouse X position and panel width when a drag begins
	const [startX, setStartX] = useState(0);
	const [startWidth, setStartWidth] = useState(0);

	// Use dynamic resize width when resizable; otherwise fall back to the fixed prop
	const effectiveWidth = resizable ? resizeWidth : width;

	/**
	 * Initiates a drag-to-resize operation by recording the starting
	 * mouse position and the current panel width.
	 */
	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			// Prevent text selection during drag
			e.preventDefault();
			setIsResizing(true);
			setStartX(e.clientX);
			setStartWidth(resizeWidth);
		},
		[resizeWidth]
	);

	// Attach/detach window-level mouse listeners while a resize drag is active
	useEffect(() => {
		if (!isResizing) return;

		const onMove = (e: MouseEvent) => {
			// Delta is inverted because the drag handle is on the left edge of a right-aligned panel
			const delta = startX - e.clientX;
			// Clamp the new width between the configured min and max bounds
			const next = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
			setResizeWidth(next);
		};
		const onUp = () => setIsResizing(false);

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		// Clean up listeners when the drag ends or the component unmounts
		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		};
	}, [isResizing, startX, startWidth, minWidth, maxWidth]);

	return (
		<Panel
			position="top-right"
			style={{
				height: '100%',
				margin: 0,
				width: effectiveWidth,
				display: visible ? 'inherit' : 'none',
			}}
		>
			<Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
				{resizable && (
					<Box
						onMouseDown={handleResizeStart}
						sx={{
							position: 'absolute',
							left: 0,
							top: '50%',
							transform: 'translate(-50%, -50%)',
							width: 8,
							height: 56,
							borderRadius: '9999px',
							cursor: 'col-resize',
							zIndex: 10,
							bgcolor: 'divider',
							opacity: 0.7,
							'&:hover': {
								opacity: 1,
								bgcolor: 'action.hover',
							},
						}}
						aria-label="Resize panel"
					/>
				)}
				<Paper id={id} variant="outlined" sx={{ width: '100%', height: '100%' }}>
					{children}
				</Paper>
			</Box>
		</Panel>
	);
}
