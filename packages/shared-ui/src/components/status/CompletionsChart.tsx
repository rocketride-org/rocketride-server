// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CompletionsChart — Real-time Chart.js line chart for processing-rate metrics.
 *
 * Ported from vscode StatusSection/CompletionsChart.tsx.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 *
 * CSS token mappings (vscode -> rr):
 *   --vscode-charts-blue   -> --rr-chart-blue   (#1976d2)
 *   --vscode-charts-red    -> --rr-chart-red     (#c62828)
 *   --vscode-charts-green  -> --rr-chart-green   (#2e7d32)
 *   --vscode-charts-purple -> --rr-chart-purple  (#9c27b0)
 *   --vscode-descriptionForeground  -> --rr-text-secondary
 *   --vscode-editorWidget-background -> --rr-bg-widget
 *   --vscode-widget-border -> --rr-border
 */

import React, { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { ChartStats, StatusDataPoint, TimeRange } from './types';

import { Chart, ChartDataset, LineController, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler } from 'chart.js';

// Register Chart.js components at module level (ONCE)
Chart.register(LineController, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	section: {
		width: '100%',
	},
	container: {
		position: 'relative',
		width: '100%',
		height: 280,
	},
};

// =============================================================================
// TYPES
// =============================================================================

interface CompletionsChartProps {
	dataPoints: StatusDataPoint[];
	timeRange: TimeRange;
	onTimeRangeChange: (range: TimeRange) => void;
	currentElapsed: number;
	onStatsCalculated: (stats: ChartStats) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Read a CSS custom property from :root, falling back to a default value.
 */
const getCssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Convert a hex color to an rgba string.
 */
const hexToRgba = (hex: string, alpha: number): string => {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (result) {
		return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
	}
	return hex;
};

/**
 * Resolve all --rr-* theme colors (with sensible fallbacks).
 */
const getThemeColors = () => {
	const chartBlue = getCssVar('--rr-chart-blue', '#1976d2');
	const chartRed = getCssVar('--rr-chart-red', '#c62828');
	const chartGreen = getCssVar('--rr-chart-green', '#2e7d32');
	const chartPurple = getCssVar('--rr-chart-purple', '#9c27b0');
	const chartOrange = getCssVar('--rr-chart-orange', '#ff9800');
	const foreground = getCssVar('--rr-text-secondary', 'rgba(204, 204, 204, 0.6)');
	const gridColor = 'rgba(128, 128, 128, 0.1)';

	return {
		blue: chartBlue,
		blueFill: hexToRgba(chartBlue, 0.15),
		red: chartRed,
		redFill: hexToRgba(chartRed, 0.15),
		green: chartGreen,
		greenFill: hexToRgba(chartGreen, 0.15),
		purple: chartPurple,
		purpleFill: hexToRgba(chartPurple, 0.15),
		orange: chartOrange,
		orangeFill: hexToRgba(chartOrange, 0.15),
		foreground,
		gridColor,
		tooltipBg: getCssVar('--rr-bg-widget', '#ffffff'),
		tooltipBorder: getCssVar('--rr-border', '#e0e0e0'),
		tooltipForeground: getCssVar('--rr-text-primary', '#1e1e1e'),
		white: '#ffffff',
	};
};

/**
 * Generate fixed labels based on time range.
 */
const generateLabels = (range: TimeRange, pointCount: number): string[] => {
	const labels: string[] = [];

	for (let i = 0; i < pointCount; i++) {
		const secondsAgo = pointCount - 1 - i;

		if (range === '1min') {
			if (secondsAgo === 0) labels.push('Now');
			else if (secondsAgo === 15) labels.push('-15s');
			else if (secondsAgo === 30) labels.push('-30s');
			else if (secondsAgo === 45) labels.push('-45s');
			else if (secondsAgo === 60) labels.push('-1m');
			else labels.push('');
		} else if (range === '5min') {
			if (secondsAgo === 0) labels.push('Now');
			else if (secondsAgo % 60 === 0) labels.push(`-${secondsAgo / 60}m`);
			else labels.push('');
		} else if (range === '15min') {
			if (secondsAgo === 0) labels.push('Now');
			else if (secondsAgo % 180 === 0) labels.push(`-${secondsAgo / 60}m`);
			else labels.push('');
		} else {
			if (secondsAgo === 0) labels.push('Now');
			else if (secondsAgo % 120 === 0) labels.push(`-${secondsAgo / 60}m`);
			else labels.push('');
		}
	}

	return labels;
};

/**
 * CompletionsChart
 *
 * Displays real-time processing rate graph with time range filters.
 * Uses Chart.js LineController for rendering.
 */
export const CompletionsChart: React.FC<CompletionsChartProps> = ({ dataPoints, timeRange, onTimeRangeChange, currentElapsed, onStatsCalculated }) => {
	const chartRef = useRef<HTMLCanvasElement>(null);
	const chartInstanceRef = useRef<Chart | null>(null);
	const filteredDataRef = useRef<StatusDataPoint[]>([]);

	/**
	 * Get filtered data points based on selected time range.
	 */
	const getFilteredDataPoints = (): StatusDataPoint[] => {
		if (timeRange === 'all') {
			return dataPoints;
		}

		const ranges: Record<TimeRange, number> = {
			'1min': 60,
			'5min': 300,
			'15min': 900,
			all: dataPoints.length,
		};

		const pointsToShow = ranges[timeRange];
		return dataPoints.slice(-pointsToShow);
	};

	/**
	 * Check if there are any failures in the filtered data.
	 */
	const hasFailures = (filtered: StatusDataPoint[]): boolean => {
		return filtered.some((p) => p.failedDelta > 0);
	};

	/**
	 * Calculate statistics from data points.
	 */
	const calculateStats = (): ChartStats => {
		const filtered = getFilteredDataPoints();
		const totals = filtered.map((p) => p.totalDelta);

		if (totals.length === 0) {
			return {
				current: 0,
				average: 0,
				peak: 0,
				minimum: 0,
				duration: currentElapsed,
			};
		}

		const current = totals[totals.length - 1] || 0;
		const sum = totals.reduce((a, b) => a + b, 0);
		const average = Math.round(sum / totals.length);
		const peak = Math.max(...totals);
		const minimum = Math.min(...totals);

		return {
			current,
			average,
			peak,
			minimum,
			duration: currentElapsed,
		};
	};

	/**
	 * Create chart ONCE on mount.
	 */
	useEffect(() => {
		if (!chartRef.current) return;

		const ctx = chartRef.current.getContext('2d');
		if (!ctx) return;

		try {
			const colors = getThemeColors();

			chartInstanceRef.current = new Chart(ctx, {
				type: 'line',
				data: {
					labels: [],
					datasets: [
						{
							label: 'Total Requests',
							data: [],
							backgroundColor: colors.blueFill,
							borderColor: colors.blue,
							borderWidth: 2,
							fill: true,
							tension: 0.4,
							pointRadius: 0,
							pointHoverRadius: 4,
							pointHoverBackgroundColor: colors.blue,
							pointHoverBorderColor: colors.white,
							pointHoverBorderWidth: 2,
							yAxisID: 'y',
						},
						{
							label: 'CPU %',
							data: [],
							backgroundColor: colors.greenFill,
							borderColor: colors.green,
							borderWidth: 2,
							fill: false,
							tension: 0.4,
							pointRadius: 0,
							pointHoverRadius: 4,
							pointHoverBackgroundColor: colors.green,
							pointHoverBorderColor: colors.white,
							pointHoverBorderWidth: 2,
							yAxisID: 'y1',
						},
						{
							label: 'CPU Memory',
							data: [],
							backgroundColor: colors.orangeFill,
							borderColor: colors.orange,
							borderWidth: 2,
							fill: false,
							tension: 0.4,
							pointRadius: 0,
							pointHoverRadius: 4,
							pointHoverBackgroundColor: colors.orange,
							pointHoverBorderColor: colors.white,
							pointHoverBorderWidth: 2,
							yAxisID: 'y2',
						},
						{
							label: 'GPU Memory',
							data: [],
							backgroundColor: colors.redFill,
							borderColor: colors.red,
							borderWidth: 2,
							fill: false,
							tension: 0.4,
							pointRadius: 0,
							pointHoverRadius: 4,
							pointHoverBackgroundColor: colors.red,
							pointHoverBorderColor: colors.white,
							pointHoverBorderWidth: 2,
							yAxisID: 'y2',
						},
					],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					animation: false,
					layout: {
						padding: {
							right: 20,
						},
					},
					plugins: {
						legend: {
							display: true,
							position: 'bottom',
							labels: {
								color: colors.foreground,
								usePointStyle: true,
								padding: 15,
								font: {
									size: 11,
								},
							},
						},
						tooltip: {
							mode: 'index',
							intersect: false,
							backgroundColor: colors.tooltipBg,
							borderColor: colors.tooltipBorder,
							borderWidth: 1,
							titleColor: colors.tooltipForeground,
							bodyColor: colors.tooltipForeground,
							callbacks: {
								title: (context) => {
									const index = context[0].dataIndex;
									const filtered = filteredDataRef.current;
									const totalPoints = filtered.length;
									const secondsAgo = totalPoints - 1 - index;

									if (secondsAgo === 0) return 'Now';
									if (secondsAgo < 60) return `${secondsAgo}s ago`;
									return `${Math.floor(secondsAgo / 60)}m ${secondsAgo % 60}s ago`;
								},
								label: (context) => {
									const label = context.dataset.label || '';
									const value = context.parsed.y ?? 0;

									if (label.includes('Completions')) {
										return `${label}: ${value}/s`;
									} else if (label.includes('%')) {
										return `${label}: ${value.toFixed(1)}%`;
									} else if (label.includes('Memory')) {
										return `${label}: ${value.toFixed(1)} GB`;
									}
									return `${label}: ${value}`;
								},
							},
						},
					},
					scales: {
						x: {
							grid: {
								display: false,
							},
							ticks: {
								maxTicksLimit: 10,
								color: colors.foreground,
								autoSkip: false,
								maxRotation: 0,
								minRotation: 0,
							},
						},
						y: {
							type: 'linear',
							display: true,
							position: 'left',
							grid: {
								color: colors.gridColor,
							},
							beginAtZero: true,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + '/s';
								},
							},
							title: {
								display: true,
								text: 'Completions (per sec)',
								color: colors.foreground,
								font: {
									size: 11,
								},
							},
						},
						y1: {
							type: 'linear',
							display: true,
							position: 'left',
							grid: {
								drawOnChartArea: false,
							},
							beginAtZero: true,
							max: 100,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + '%';
								},
							},
							title: {
								display: true,
								text: 'CPU %',
								color: colors.foreground,
								font: {
									size: 11,
								},
							},
						},
						y2: {
							type: 'linear',
							display: true,
							position: 'right',
							grid: {
								drawOnChartArea: false,
							},
							beginAtZero: true,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + ' GB';
								},
							},
							title: {
								display: true,
								text: 'Memory (GB)',
								color: colors.foreground,
								font: {
									size: 11,
								},
							},
						},
					},
					interaction: {
						intersect: false,
						mode: 'index',
					},
				},
			});
		} catch (error) {
			console.error('Failed to create chart:', error);
		}

		return () => {
			if (chartInstanceRef.current) {
				try {
					chartInstanceRef.current.destroy();
				} catch (error) {
					console.error('Failed to destroy chart:', error);
				}
			}
		};
	}, []);

	/**
	 * Update chart data when dataPoints or timeRange changes.
	 */
	useEffect(() => {
		if (!chartInstanceRef.current) return;

		const filtered = getFilteredDataPoints();
		filteredDataRef.current = filtered;

		const colors = getThemeColors();

		const labels = generateLabels(timeRange, filtered.length);
		const totalData = filtered.map((p) => p.totalDelta);
		const failedData = filtered.map((p) => p.failedDelta);
		const cpuPercentData = filtered.map((p) => p.cpuPercent || 0);
		const cpuMemoryData = filtered.map((p) => (p.cpuMemoryMb || 0) / 1000);
		const gpuMemoryData = filtered.map((p) => (p.gpuMemoryMb || 0) / 1000);
		const showFailures = hasFailures(filtered);

		const datasets: ChartDataset<'line', number[]>[] = [
			{
				label: 'Total Completions',
				data: totalData,
				backgroundColor: colors.blueFill,
				borderColor: colors.blue,
				borderWidth: 2,
				fill: true,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: colors.blue,
				pointHoverBorderColor: colors.white,
				pointHoverBorderWidth: 2,
				yAxisID: 'y',
			},
			{
				label: 'CPU %',
				data: cpuPercentData,
				backgroundColor: colors.greenFill,
				borderColor: colors.green,
				borderWidth: 2,
				fill: false,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: colors.green,
				pointHoverBorderColor: colors.white,
				pointHoverBorderWidth: 2,
				yAxisID: 'y1',
			},
			{
				label: 'CPU Memory',
				data: cpuMemoryData,
				backgroundColor: colors.orangeFill,
				borderColor: colors.orange,
				borderWidth: 2,
				fill: false,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: colors.orange,
				pointHoverBorderColor: colors.white,
				pointHoverBorderWidth: 2,
				yAxisID: 'y2',
			},
			{
				label: 'GPU Memory',
				data: gpuMemoryData,
				backgroundColor: colors.redFill,
				borderColor: colors.red,
				borderWidth: 2,
				fill: false,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: colors.red,
				pointHoverBorderColor: colors.white,
				pointHoverBorderWidth: 2,
				yAxisID: 'y2',
			},
		];

		if (showFailures) {
			datasets.splice(1, 0, {
				label: 'Failed Completions',
				data: failedData,
				backgroundColor: colors.redFill,
				borderColor: colors.red,
				borderWidth: 2,
				fill: true,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				pointHoverBackgroundColor: colors.red,
				pointHoverBorderColor: colors.white,
				pointHoverBorderWidth: 2,
				yAxisID: 'y',
			});
		}

		chartInstanceRef.current.data.labels = labels;
		chartInstanceRef.current.data.datasets = datasets;
		chartInstanceRef.current.update('none');

		// Calculate and pass stats to parent
		const stats = calculateStats();
		onStatsCalculated(stats);

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dataPoints, timeRange, currentElapsed]);

	return (
		<div style={styles.section}>
			<div style={styles.container}>
				<canvas ref={chartRef} />
			</div>
		</div>
	);
};

export default CompletionsChart;
