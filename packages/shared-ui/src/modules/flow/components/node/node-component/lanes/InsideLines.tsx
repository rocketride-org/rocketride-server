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

/**
 * InsideLines — SVG bezier curves drawn inside a canvas node.
 *
 * Renders smooth curves connecting input lane handles to their corresponding
 * output lane handles within a single node body. These internal lines help
 * users understand the data flow within a node by showing which input feeds
 * which output.
 *
 * Visual treatment:
 *   - Connected outputs: solid lines at full opacity
 *   - Unconnected outputs: dashed lines at 25% opacity
 *
 * The curves are computed after the DOM renders (via useEffect) so that
 * handle positions can be accurately measured from the laid-out elements.
 * Uses D3's cubic basis curve interpolation for smooth S-curves.
 *
 * Returns null when there is nothing to draw (no parent element, no
 * connections, or no lanes).
 */

import { useMemo, useState, useEffect } from 'react';
import * as d3 from 'd3';
import { ILaneObject } from '../../../../types';

interface IProps {
	parentEl: HTMLElement;
	inputConnected: boolean;
	inputLanes: {
		key: string;
		connected: boolean;
		index: number;
		totalInputs: number;
		outputMapping?: string[];
	}[];
	outputLanes: {
		key: string | ILaneObject;
		connected: boolean;
	}[];
}

interface ILinesData {
	key: string;
	show: boolean;
	opacity: number;
	strokeDasharray: string;
	data: {
		x: number;
		y: number;
	}[];
}

export default function InsideLines({ parentEl, inputConnected, inputLanes = [], outputLanes = [] }: IProps) {
	const [lines, setLines] = useState<ILinesData[]>([]);

	useEffect(() => {
		if (!parentEl || !inputConnected || outputLanes.length === 0 || inputLanes.length === 0) {
			setLines([]);
			return;
		}
		const parentRect = parentEl.getBoundingClientRect();
		const scaleX = parentEl.clientWidth / parentRect.width;
		const scaleY = parentEl.clientHeight / parentRect.height;

		const getLanePosition = (handleId: string, isInput: boolean): { x: number; y: number } | null => {
			const handleEl = parentEl.querySelector(`[data-handleid="${handleId}"]`);
			if (!handleEl) return null;
			const typographyEl = handleEl.closest('span');
			if (!typographyEl) return null;
			const laneEl = typographyEl.parentElement;
			if (!laneEl) return null;

			const parentRect = parentEl.getBoundingClientRect();
			const typographyRect = typographyEl.getBoundingClientRect();
			const relativeX = typographyRect.left - parentRect.left;
			const relativeY = typographyRect.top - parentRect.top;
			const yTransformed = relativeY + typographyRect.height / 2;
			const y = yTransformed * scaleY;
			const xTransformed = isInput ? relativeX + typographyRect.width : relativeX;
			const x = xTransformed * scaleX;
			return { x, y };
		};

		const linesList: ILinesData[] = [];

		for (const inputLane of inputLanes) {
			if (!inputLane.connected) continue;
			const targetOutputKeys = inputLane.outputMapping || [inputLane.key];

			for (const outputKey of targetOutputKeys) {
				const outputLane = outputLanes.find((o) => o.key === outputKey);
				if (!outputLane) continue;

				const isFullyConnected = outputLane.connected;
				const opacity = isFullyConnected ? 1.0 : 0.25;
				const strokeDasharray = isFullyConnected ? '0' : '2,4';
				const inputHandleId = `target-${inputLane.key}`;
				const outputHandleId = `source-${outputKey}`;
				const inputPos = getLanePosition(inputHandleId, true);
				const outputPos = getLanePosition(outputHandleId, false);
				if (!inputPos || !outputPos) continue;

				const controlOffset = 15;
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

	const line = useMemo(
		() =>
			d3
				.line()
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.x((d: any) => d.x)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.y((d: any) => d.y)
				.curve(d3.curveBasis),
		[]
	);

	if (!parentEl || !inputConnected || outputLanes.length === 0 || inputLanes.length === 0) {
		return null;
	}

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
				overflow: 'visible',
			}}
		>
			{lines.map((item) => (
				<path key={item.key} id={item.key} d={line(item.data)} stroke="var(--rr-border)" strokeDasharray={item.strokeDasharray} fill="none" opacity={item.show ? item.opacity : 0} />
			))}
		</svg>
	);
}
