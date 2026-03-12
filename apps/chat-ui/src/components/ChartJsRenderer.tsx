/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import React, { useMemo } from 'react';
import {
	Chart as ChartJS,
	CategoryScale,
	LinearScale,
	RadialLinearScale,
	PointElement,
	LineElement,
	BarElement,
	ArcElement,
	Filler,
	Tooltip,
	Legend,
	Title,
} from 'chart.js';
import { Bar, Line, Pie, Doughnut, Radar, PolarArea, Scatter, Bubble } from 'react-chartjs-2';

ChartJS.register(
	CategoryScale,
	LinearScale,
	RadialLinearScale,
	PointElement,
	LineElement,
	BarElement,
	ArcElement,
	Filler,
	Tooltip,
	Legend,
	Title,
);

const CHART_COMPONENTS: Record<string, React.ComponentType<any>> = {
	bar: Bar,
	line: Line,
	pie: Pie,
	doughnut: Doughnut,
	radar: Radar,
	polarArea: PolarArea,
	scatter: Scatter,
	bubble: Bubble,
};

interface ChartJsRendererProps {
	config: string;
}

/**
 * Recursively strip any string values that look like stringified functions
 * (e.g. "function(context){ ... }") since Chart.js cannot execute those
 * from JSON — they would render as literal text.
 */
function stripFunctionStrings(obj: unknown): unknown {
	if (typeof obj === 'string' && /^\s*function\s*\(/.test(obj)) {
		return undefined;
	}
	if (Array.isArray(obj)) {
		return obj.map(stripFunctionStrings);
	}
	if (obj !== null && typeof obj === 'object') {
		const cleaned: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
			const v = stripFunctionStrings(value);
			if (v !== undefined) {
				cleaned[key] = v;
			}
		}
		return cleaned;
	}
	return obj;
}

export const ChartJsRenderer: React.FC<ChartJsRendererProps> = ({ config }) => {
	const result = useMemo(() => {
		try {
			const raw = JSON.parse(config);
			const parsed = stripFunctionStrings(raw) as Record<string, any>;

			if (!parsed.type || !parsed.data) {
				return { error: 'Chart config must include "type" and "data" fields.', parsed: null, raw: config };
			}

			return { error: null, parsed, raw: config };
		} catch {
			return { error: 'Invalid JSON in chart configuration.', parsed: null, raw: config };
		}
	}, [config]);

	if (result.error || !result.parsed) {
		return (
			<div className="chartjs-error">
				<strong>{result.error}</strong>
				<pre>{result.raw}</pre>
			</div>
		);
	}

	const { type, data, options = {} } = result.parsed;
	const ChartComponent = CHART_COMPONENTS[type] || Bar;

	const mergedOptions = {
		...options,
		responsive: true,
		maintainAspectRatio: true,
	};

	return (
		<div className="chartjs-container">
			<ChartComponent data={data} options={mergedOptions} />
		</div>
	);
};
