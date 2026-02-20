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

/**
 * Props for the ContextMenu component.
 * Represents the position, snap-to-grid state, and callbacks needed to render
 * and interact with the canvas right-click context menu.
 */
interface ContextMenuProps {
	/** Horizontal pixel position where the context menu should appear. */
	x: number;
	/** Vertical pixel position where the context menu should appear. */
	y: number;
	/** Whether snap-to-grid is currently enabled on the canvas. */
	snapToGrid: boolean;
	/** The current grid cell size as a [width, height] tuple in pixels. */
	snapGridSize: [number, number];
	/** Callback to toggle the snap-to-grid feature on or off. */
	onToggleSnapToGrid: () => void;
	/** Callback to change the snap grid cell size. */
	onChangeSnapGrid: (newGridSize: [number, number]) => void;
	/** Callback to close/dismiss the context menu. */
	onClose: () => void;
}

/**
 * Available grid size presets for the snap-to-grid feature.
 * Each option provides a human-readable label and the corresponding [width, height] tuple.
 */
const gridOptions = [
	{ label: '10x10', value: [10, 10] as [number, number] },
	{ label: '15x15', value: [15, 15] as [number, number] },
	{ label: '20x20', value: [20, 20] as [number, number] },
	{ label: '25x25', value: [25, 25] as [number, number] },
	{ label: '30x30', value: [30, 30] as [number, number] },
];

/**
 * Renders a right-click context menu on the canvas pane, providing controls for
 * toggling snap-to-grid and selecting a grid size. The menu is positioned at the
 * mouse coordinates and auto-closes after any action is taken.
 *
 * @param props - The context menu position, state, and action callbacks.
 * @returns The rendered context menu element.
 */
export default function ContextMenu({
	x,
	y,
	snapToGrid,
	snapGridSize,
	onToggleSnapToGrid,
	onChangeSnapGrid,
	onClose,
}: ContextMenuProps): ReactElement {
	/**
	 * Toggles snap-to-grid and then closes the context menu.
	 */
	const handleToggleSnapToGrid = () => {
		// Toggle the grid snap setting and immediately close the menu
		onToggleSnapToGrid();
		onClose();
	};

	/**
	 * Changes the snap grid size and then closes the context menu.
	 * @param newGridSize - The new grid dimensions as a [width, height] tuple.
	 */
	const handleChangeSnapGrid = (newGridSize: [number, number]) => {
		// Apply the selected grid size and close the menu after selection
		onChangeSnapGrid(newGridSize);
		onClose();
	};

	return (
		<div
			style={{
				position: 'fixed',
				top: y,
				left: x,
				backgroundColor: 'white',
				border: '1px solid #ccc',
				borderRadius: '4px',
				boxShadow: '0 2px 10px rgba(0, 0, 0, 0.1)',
				zIndex: 1000,
				minWidth: '180px',
			}}
		>
			<div
				style={{
					padding: '8px 12px',
					cursor: 'pointer',
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					borderBottom: '1px solid #eee',
				}}
				onClick={handleToggleSnapToGrid}
				onMouseEnter={(e) => {
					e.currentTarget.style.backgroundColor = '#f0f0f0';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.backgroundColor = 'transparent';
				}}
			>
				<span style={{ width: '16px', textAlign: 'center' }}>{snapToGrid ? '✓' : ''}</span>
				<span>Snap to Grid</span>
			</div>

			{snapToGrid && (
				<>
					<div
						style={{
							padding: '8px 12px',
							fontSize: '12px',
							fontWeight: 'bold',
							color: '#666',
							backgroundColor: '#f8f8f8',
						}}
					>
						Grid Size
					</div>
					{gridOptions.map((option) => (
						<div
							key={option.label}
							style={{
								padding: '8px 12px',
								cursor: 'pointer',
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
							}}
							onClick={() => handleChangeSnapGrid(option.value)}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = '#f0f0f0';
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
						>
							<span
								style={{
									width: '16px',
									textAlign: 'center',
								}}
							>
								{snapGridSize[0] === option.value[0] &&
								snapGridSize[1] === option.value[1]
									? '●'
									: ''}
							</span>
							<span>{option.label}</span>
						</div>
					))}
				</>
			)}
		</div>
	);
}
