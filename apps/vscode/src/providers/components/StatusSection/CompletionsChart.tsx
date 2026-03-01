// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import { ChartStats } from './types';
import React, { useEffect, useRef } from 'react';
import { StatusDataPoint, TimeRange } from './types';

import {
	Chart,
	ChartDataset,
	LineController,
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	Title,
	Tooltip,
	Legend,
	Filler
	// DO NOT REMOVE THIS!!!
	// @ts-expect-error - ESM import handled by Rsbuild at build time
} from 'chart.js';

// Register Chart.js components at module level (ONCE)
Chart.register(
	LineController,
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	Title,
	Tooltip,
	Legend,
	Filler
);

interface CompletionsChartProps {
	dataPoints: StatusDataPoint[];
	timeRange: TimeRange;
	onTimeRangeChange: (range: TimeRange) => void;
	currentElapsed: number;
	onStatsCalculated: (stats: ChartStats) => void;
}

/**
 * Generate fixed labels based on time range
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
 * Get VS Code theme colors with fallbacks
 */
const getThemeColors = () => {
	const computedStyle = getComputedStyle(document.documentElement);

	const getColor = (varName: string, fallback: string): string => {
		const color = computedStyle.getPropertyValue(varName).trim();
		return color || fallback;
	};

	const hexToRgba = (hex: string, alpha: number): string => {
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		if (result) {
			return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
		}
		return hex;
	};

	const chartBlue = getColor('--vscode-charts-blue', '#1177bb');
	const chartRed = getColor('--vscode-charts-red', '#f44336');
	const chartGreen = getColor('--vscode-charts-green', '#4caf50');
	const chartPurple = getColor('--vscode-charts-purple', '#9c27b0');
	const chartOrange = getColor('--vscode-charts-orange', '#ff9800');
	const foreground = getColor('--vscode-descriptionForeground', 'rgba(204, 204, 204, 0.6)');
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
		tooltipBg: getColor('--vscode-editorWidget-background', '#ffffff'),
		tooltipBorder: getColor('--vscode-widget-border', '#e0e0e0'),
		tooltipForeground: getColor('--vscode-editorWidget-foreground', '#1e1e1e'),
		white: '#ffffff'
	};
};

/**
 * Completions Chart Component
 * 
 * Displays real-time processing rate graph with time range filters.
 */
export const CompletionsChart: React.FC<CompletionsChartProps> = ({
	dataPoints,
	timeRange,
	onTimeRangeChange,
	currentElapsed,
	onStatsCalculated
}) => {
	const chartRef = useRef<HTMLCanvasElement>(null);
	const chartInstanceRef = useRef<Chart | null>(null);
	const filteredDataRef = useRef<StatusDataPoint[]>([]);

	/**
	 * Get filtered data points based on selected time range
	 */
	const getFilteredDataPoints = (): StatusDataPoint[] => {
		if (timeRange === 'all') {
			return dataPoints;
		}

		const ranges: Record<TimeRange, number> = {
			'1min': 60,
			'5min': 300,
			'15min': 900,
			'all': dataPoints.length
		};

		const pointsToShow = ranges[timeRange];
		return dataPoints.slice(-pointsToShow);
	};

	/**
	 * Check if there are any failures in the filtered data
	 */
	const hasFailures = (filtered: StatusDataPoint[]): boolean => {
		return filtered.some(p => p.failedDelta > 0);
	};

	/**
	 * Calculate statistics from data points
	 */
	const calculateStats = (): ChartStats => {
		const filtered = getFilteredDataPoints();
		const totals = filtered.map(p => p.totalDelta);

		if (totals.length === 0) {
			return {
				current: 0,
				average: 0,
				peak: 0,
				minimum: 0,
				duration: currentElapsed
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
			duration: currentElapsed
		};
	};

	/**
	 * Create chart ONCE on mount
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
							yAxisID: 'y'
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
							yAxisID: 'y1'
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
							yAxisID: 'y2'
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
							yAxisID: 'y2'
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					animation: false,
					layout: {
						padding: {
							right: 20
						}
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
									size: 11
								}
							}
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

									// Format based on dataset
									if (label.includes('Completions')) {
										return `${label}: ${value}/s`;
									} else if (label.includes('%')) {
										return `${label}: ${value.toFixed(1)}%`;
									} else if (label.includes('Memory')) {
										return `${label}: ${value.toFixed(1)} GB`;
									}
									return `${label}: ${value}`;
								}
							}
						}
					},
					scales: {
						x: {
							grid: {
								display: false
							},
							ticks: {
								maxTicksLimit: 10,
								color: colors.foreground,
								autoSkip: false,
								maxRotation: 0,
								minRotation: 0
							}
						},
						y: {
							type: 'linear',
							display: true,
							position: 'left',
							grid: {
								color: colors.gridColor
							},
							beginAtZero: true,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + '/s';
								}
							},
							title: {
								display: true,
								text: 'Completions (per sec)',
								color: colors.foreground,
								font: {
									size: 11
								}
							}
						},
						y1: {
							type: 'linear',
							display: true,
							position: 'left',
							grid: {
								drawOnChartArea: false
							},
							beginAtZero: true,
							max: 100,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + '%';
								}
							},
							title: {
								display: true,
								text: 'CPU %',
								color: colors.foreground,
								font: {
									size: 11
								}
							}
						},
						y2: {
							type: 'linear',
							display: true,
							position: 'right',
							grid: {
								drawOnChartArea: false
							},
							beginAtZero: true,
							ticks: {
								color: colors.foreground,
								callback: function (value) {
									return value + ' GB';
								}
							},
							title: {
								display: true,
								text: 'Memory (GB)',
								color: colors.foreground,
								font: {
									size: 11
								}
							}
						}
					},
					interaction: {
						intersect: false,
						mode: 'index'
					}
				}
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
	 * Update chart data when dataPoints or timeRange changes
	 */
	useEffect(() => {
		if (!chartInstanceRef.current) return;

		const filtered = getFilteredDataPoints();
		filteredDataRef.current = filtered;

		const colors = getThemeColors();

		const labels = generateLabels(timeRange, filtered.length);
		const totalData = filtered.map(p => p.totalDelta);
		const failedData = filtered.map(p => p.failedDelta);
		const cpuPercentData = filtered.map(p => p.cpuPercent || 0);
		const cpuMemoryData = filtered.map(p => (p.cpuMemoryMb || 0) / 1000); // Convert CPU memory MB to GB
		const gpuMemoryData = filtered.map(p => (p.gpuMemoryMb || 0) / 1000); // Convert GPU memory MB to GB
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
				yAxisID: 'y'
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
				yAxisID: 'y1'
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
				yAxisID: 'y2'
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
				yAxisID: 'y2'
			}
		];

		if (showFailures) {
			// Insert failed completions as second dataset
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
				yAxisID: 'y'
			});
		}

		chartInstanceRef.current.data.labels = labels;
		chartInstanceRef.current.data.datasets = datasets;
		chartInstanceRef.current.update('none');

		// Calculate and pass stats to parent
		const stats = calculateStats();
		onStatsCalculated(stats);

		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: avoid rerun on callback/stable refs
	}, [dataPoints, timeRange, currentElapsed]);

	return (
		<div className="chart-section">
			<div className="chart-container">
				<canvas ref={chartRef} className="chart-canvas"></canvas>
			</div>
		</div>
	);
};
