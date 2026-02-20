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

import { useMemo, useState, useEffect } from 'react';
import * as d3 from 'd3';
import { LaneObject } from '../../types';

/**
 * Props for the InsideLines component.
 *
 * Provides the parent DOM element for coordinate calculations and the
 * connection metadata for input and output lanes so that internal curves
 * can be drawn between them.
 */
interface IProps {
	/** The parent DOM element used as a coordinate reference for SVG positioning. */
	parentEl: HTMLElement;
	/** Whether at least one input lane has an active incoming connection. */
	inputConnected: boolean;
	/** Metadata for each visible input lane, including connection status and output mapping. */
	inputLanes: {
		key: string;
		connected: boolean;
		index: number;
		totalInputs: number;
		/** Which output lane types this input lane can write to. */
		outputMapping?: string[];
	}[];
	/** Metadata for each output lane, including connection status. */
	outputLanes: {
		key: string | LaneObject;
		connected: boolean;
	}[];
}

/**
 * Represents a single SVG curve line drawn inside a node between an
 * input lane and its corresponding output lane(s).
 */
interface ILinesData {
	/** Unique key identifying this line (e.g. "inputType-to-outputType"). */
	key: string;
	/** Whether the line should be visible. */
	show: boolean;
	/** SVG stroke opacity -- full for connected outputs, faint for unconnected. */
	opacity: number;
	/** SVG stroke dash pattern -- solid for connected, dotted for unconnected. */
	strokeDasharray: string;
	/** Array of control points defining the bezier curve path. */
	data: {
		x: number;
		y: number;
	}[];
}

/**
 * Renders SVG bezier curves inside a canvas node to visually connect input lanes
 * to their corresponding output lanes.
 *
 * These internal lines help users understand the data flow within a single node by
 * showing which input feeds which output. Connected outputs are drawn with solid
 * lines at full opacity, while unconnected outputs use dashed, faint lines. The
 * curves are computed after the DOM renders (via useEffect) so that handle positions
 * are accurately measured.
 *
 * @param props - Parent element reference and lane connection metadata.
 * @returns An SVG overlay with bezier path lines, or null if there is nothing to draw.
 */
export default function InsideLines({
	parentEl,
	inputConnected,
	inputLanes = [],
	outputLanes = [],
}: IProps) {
	// Lines are stored in state because they depend on DOM measurements
	// that are only available after the initial render cycle
	const [lines, setLines] = useState<ILinesData[]>([]);

	// Compute line paths in useEffect so we read from the already-laid-out DOM.
	// Runs whenever lane data changes or the parent element reference updates.
	useEffect(() => {
		// Bail out early if there is nothing to draw (no parent, no connections, or no lanes)
		if (!parentEl || !inputConnected || outputLanes.length === 0 || inputLanes.length === 0) {
			setLines([]);
			return;
		}
		const parentRect = parentEl.getBoundingClientRect();

		// When the node is zoomed/transformed, clientWidth/Height (untransformed) differs
		// from getBoundingClientRect (transformed). The ratio gives us a correction factor.
		const scaleX = parentEl.clientWidth / parentRect.width;
		const scaleY = parentEl.clientHeight / parentRect.height;

		// Get position of a LANE element (not the handle!) relative to parent container in PIXELS
		// Resolve the pixel position of a lane's label element relative to the parent container.
		// We use the Typography element (not the tiny handle dot) because it gives a more
		// accurate anchor point for the curve start/end.
		const getLanePosition = (
			handleId: string,
			isInput: boolean
		): { x: number; y: number } | null => {
			// Find the ReactFlow handle element by its data attribute
			const handleEl = parentEl.querySelector(`[data-handleid="${handleId}"]`);
			if (!handleEl) {
				return null;
			}

			// Walk up the DOM: Handle -> Typography <p> -> Box (connectionType container)
			const typographyEl = handleEl.closest('p');
			if (!typographyEl) {
				return null;
			}

			const laneEl = typographyEl.parentElement;
			if (!laneEl) {
				return null;
			}

			// Re-measure the parent rect inside this closure because the outer one may be stale
			const parentRect = parentEl.getBoundingClientRect();
			const typographyRect = typographyEl.getBoundingClientRect();

			// Convert from viewport coordinates to parent-relative coordinates
			const relativeX = typographyRect.left - parentRect.left;
			const relativeY = typographyRect.top - parentRect.top;

			// Vertically center the curve endpoint on the lane label
			const yTransformed = relativeY + typographyRect.height / 2;
			const y = yTransformed * scaleY;

			// For inputs, start the curve at the right edge of the label;
			// for outputs, end it at the left edge -- so curves span the gap between them
			const xTransformed = isInput ? relativeX + typographyRect.width : relativeX;
			const x = xTransformed * scaleX;

			return { x, y };
		};

		const linesList: ILinesData[] = [];

		// Iterate over every input lane and draw curves to each of its mapped outputs
		for (const inputLane of inputLanes) {
			// Only draw lines from connected inputs -- disconnected inputs have no data flowing
			if (!inputLane.connected) {
				continue;
			}

			// Resolve output targets: use the explicit mapping if available,
			// otherwise fall back to a same-key convention (input type == output type)
			const targetOutputKeys = inputLane.outputMapping || [inputLane.key];

			for (const outputKey of targetOutputKeys) {
				const outputLane = outputLanes.find((o) => o.key === outputKey);

				// The mapping may reference an output that does not exist on this node -- skip gracefully
				if (!outputLane) {
					continue;
				}

				// Visual distinction: solid/opaque for fully wired paths, dashed/faint for partial
				const isFullyConnected = outputLane.connected;
				const opacity = isFullyConnected ? 1.0 : 0.25;
				const strokeDasharray = isFullyConnected ? '0' : '2,4';

				// Build handle IDs that match the DOM data-handleid attributes
				const inputHandleId = `target-${inputLane.key}`;
				const outputHandleId = `source-${outputKey}`;

				// Measure actual pixel positions from the DOM
				const inputPos = getLanePosition(inputHandleId, true);
				const outputPos = getLanePosition(outputHandleId, false);

				// Skip if either handle element was not found in the DOM
				if (!inputPos || !outputPos) {
					continue;
				}

				// Define a cubic bezier with two control points offset horizontally from the endpoints.
				// This produces a smooth S-curve when input and output are at different vertical positions.
				const controlOffset = 15; // pixels of horizontal pull for the control points
				linesList.push({
					key: `${inputLane.key}-to-${outputKey}`,
					show: true,
					opacity,
					strokeDasharray,
					data: [
						{ x: inputPos.x, y: inputPos.y },
						{ x: inputPos.x + controlOffset, y: inputPos.y },
						{ x: outputPos.x - controlOffset, y: outputPos.y },
						{ x: outputPos.x, y: outputPos.y },
					],
				});
			}
		}

		setLines(linesList);
	}, [inputLanes, outputLanes, parentEl, inputConnected]);

	/**
	 * D3 line generator configured with a cubic basis curve interpolation.
	 * Converts arrays of {x, y} data points into SVG path `d` attribute strings.
	 */
	const line = useMemo(
		() =>
			d3
				.line()
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.x((d: any) => d.x) // Use pixel values directly
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.y((d: any) => d.y) // Use pixel values directly
				.curve(d3.curveBasis),
		[]
	);

	// Guard: render nothing if prerequisites are not met
	if (!parentEl || !inputConnected || outputLanes.length === 0 || inputLanes.length === 0) {
		return null;
	}

	// Use clientWidth/Height (untransformed) so the SVG coordinate space
	// matches the pixel positions computed inside the effect above
	const svgWidth = parentEl.clientWidth;
	const svgHeight = parentEl.clientHeight;

	return (
		<svg
			width={svgWidth}
			height={svgHeight}
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				overflow: 'visible', // Allow drawing outside SVG bounds
			}}
		>
			{lines.map((item) => (
				<path
					key={item.key}
					id={item.key}
					d={line(item.data)}
					stroke="#b1b1b7"
					strokeDasharray={item.strokeDasharray}
					fill="none"
					opacity={item.show ? item.opacity : 0}
				/>
			))}
		</svg>
	);
}
