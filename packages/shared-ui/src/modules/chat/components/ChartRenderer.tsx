// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useMemo, type CSSProperties } from 'react';
import { Chart as ChartJS, CategoryScale, LinearScale, RadialLinearScale, PointElement, LineElement, BarElement, ArcElement, Filler, Tooltip, Legend, Title } from 'chart.js';
import { Bar, Line, Pie, Doughnut, Radar, PolarArea, Scatter, Bubble } from 'react-chartjs-2';
import { commonStyles } from '../../../themes/styles';

ChartJS.register(CategoryScale, LinearScale, RadialLinearScale, PointElement, LineElement, BarElement, ArcElement, Filler, Tooltip, Legend, Title);

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

const S = {
	container: {
		padding: 16,
		maxWidth: 600,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	error: {
		...commonStyles.cardFlat,
		border: '1px solid var(--rr-color-error)',
		fontSize: 13,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	errorPre: {
		marginTop: 8,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		overflowX: 'auto' as const,
	} as CSSProperties,
};

/** Recursively strips stringified function values (LLMs may generate these). */
function stripFunctionStrings(obj: unknown, visited = new Set<unknown>()): unknown {
	if (typeof obj === 'string' && /^\s*(function\s*\(|\(.*\)\s*=>|[a-zA-Z_$][\w$]*\s*=>)/.test(obj)) return undefined;
	if (Array.isArray(obj)) return obj.map((v) => stripFunctionStrings(v, visited));
	if (obj !== null && typeof obj === 'object') {
		if (visited.has(obj)) return undefined;
		visited.add(obj);
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			const c = stripFunctionStrings(v, visited);
			if (c !== undefined) cleaned[k] = c;
		}
		return cleaned;
	}
	return obj;
}

interface ChartRendererProps {
	config: string;
}

export const ChartRenderer: React.FC<ChartRendererProps> = ({ config }) => {
	const result = useMemo(() => {
		try {
			let clean = config.trim();
			if (clean.startsWith('```chartjs')) {
				clean = clean.slice(10).trim();
				if (clean.endsWith('```')) clean = clean.slice(0, -3).trim();
			}
			const raw = JSON.parse(clean);
			const parsed = stripFunctionStrings(raw) as Record<string, any>;
			if (!parsed.type || !parsed.data) return { error: 'Chart config must include "type" and "data".', parsed: null };
			return { error: null, parsed };
		} catch {
			return { error: 'Invalid JSON in chart configuration.', parsed: null };
		}
	}, [config]);

	if (result.error || !result.parsed) {
		return (
			<div style={S.error}>
				<strong>{result.error}</strong>
				<pre style={S.errorPre}>{config}</pre>
			</div>
		);
	}

	const { type, data, options = {} } = result.parsed;
	const ChartComponent = CHART_COMPONENTS[type] ?? Bar;
	return (
		<div style={S.container}>
			<ChartComponent data={data} options={{ ...options, responsive: true, maintainAspectRatio: true }} />
		</div>
	);
};
