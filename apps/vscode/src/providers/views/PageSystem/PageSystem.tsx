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

import React, { useState, useEffect, useRef } from 'react';
import { useMessaging } from '../../../shared/util/useMessaging';
import { ConnectionState } from '../../../shared/types';
import type { SystemInfo } from '../../PageSystemProvider';
import {
	Chart,
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

// Import the styles
import '../../styles/vscode.css'
import '../../styles/app.css';
import './styles.css';

// Register Chart.js components
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

// ============================================================================
// SYSTEM PERFORMANCE PAGE COMPONENT
// ============================================================================

export type PageSystemIncomingMessage
	= {
		type: 'update';
		systemInfo: SystemInfo;
		state: ConnectionState;
	}
	| {
		type: 'connectionState';
		state: ConnectionState;
	}
	| {
		type: 'error';
		error: string;
		state: ConnectionState;
	};

export type PageSystemOutgoingMessage
	= {
		type: 'ready';
	};

interface DataPoint {
	timestamp: number;
	cpuUtilization: number;
	memoryUtilization: number;
}

/**
 * PageSystem - Main Layout Component for System Performance Monitoring
 * 
 * Displays real-time system performance metrics including:
 * - CPU cores and platform information
 * - GPU size
 * - Disk utilization over time (rolling chart)
 * - Individual disk statistics
 * - Path-specific disk usage (cache, control, data, log)
 */
export const PageSystem: React.FC = () => {
	// ========================================================================
	// STATE MANAGEMENT
	// ========================================================================
	const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
	const [connectionState, setConnectionState] = useState<ConnectionState | null>(null);
	const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const chartRef = useRef<HTMLCanvasElement>(null);
	const chartInstanceRef = useRef<Chart | null>(null);

	// Maximum number of data points to keep (5 minutes at 2s intervals = 150 points)
	const MAX_DATA_POINTS = 150;

	// ========================================================================
	// WEBVIEW MESSAGING
	// ========================================================================

	const { sendMessage, isReady } = useMessaging<
		PageSystemOutgoingMessage, PageSystemIncomingMessage>({
		onMessage: (message) => {
		switch (message.type) {
			case 'update': {
				setSystemInfo(message.systemInfo);
				setConnectionState(message.state);
				setErrorMessage(null); // Clear any previous errors
				
				// Add new data point for CPU and memory utilization
				setDataPoints(prev => {
					const newPoint: DataPoint = {
						timestamp: Date.now(),
						cpuUtilization: message.systemInfo.cpuUtilization || 0,
						memoryUtilization: message.systemInfo.memoryUtilization || 0
					};
					const updated = [...prev, newPoint];
					// Keep only the last MAX_DATA_POINTS
					return updated.slice(-MAX_DATA_POINTS);
				});
				break;
			}
				case 'connectionState': {
					setConnectionState(message.state);
					break;
				}
				case 'error': {
					setConnectionState(message.state);
					setErrorMessage(message.error);
					break;
				}
			}
		}
		});

	// ========================================================================
	// EFFECTS
	// ========================================================================

	/**
	 * Send ready message when messaging is initialized
	 */
	useEffect(() => {
		if (isReady) {
			sendMessage({ type: 'ready' });
		}
	}, [isReady, sendMessage]);

	/**
	 * Initialize chart when canvas becomes available
	 */
	useEffect(() => {
		// Only initialize if we have system info (which means canvas is rendered) and no chart yet
		if (!systemInfo) {
			return;
		}
		
		if (chartInstanceRef.current) {
			return;
		}
		
		if (!chartRef.current) {
			return;
		}

		const ctx = chartRef.current.getContext('2d');
		if (!ctx) {
			return;
		}

		const colors = getThemeColors();

		chartInstanceRef.current = new Chart(ctx, {
			type: 'line',
			data: {
				labels: [],
				datasets: [
					{
						label: 'CPU Utilization %',
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
						pointHoverBorderWidth: 2
					},
					{
						label: 'Memory Utilization %',
						data: [],
						backgroundColor: colors.greenFill,
						borderColor: colors.green,
						borderWidth: 2,
						fill: true,
						tension: 0.4,
						pointRadius: 0,
						pointHoverRadius: 4,
						pointHoverBackgroundColor: colors.green,
						pointHoverBorderColor: colors.white,
						pointHoverBorderWidth: 2
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
						display: false
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
								const point = dataPoints[index];
								if (!point) return 'Unknown';
								
								const secondsAgo = Math.floor((Date.now() - point.timestamp) / 1000);
								if (secondsAgo === 0) return 'Now';
								if (secondsAgo < 60) return `${secondsAgo}s ago`;
								return `${Math.floor(secondsAgo / 60)}m ${secondsAgo % 60}s ago`;
							},
							label: (context) => {
								const value = context.parsed.y ?? 0;
								return `${context.dataset.label}: ${value.toFixed(1)}%`;
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
							color: colors.foreground,
							maxTicksLimit: 10,
							callback: function(value, index) {
								if (index === 0) return 'Start';
								if (index === dataPoints.length - 1) return 'Now';
								return '';
							}
						}
					},
					y: {
						grid: {
							color: colors.gridColor
						},
						beginAtZero: true,
						max: 100,
						ticks: {
							color: colors.foreground,
							callback: function (value) {
								return value + '%';
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

		return () => {
			if (chartInstanceRef.current) {
				chartInstanceRef.current.destroy();
				chartInstanceRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: init chart once when systemInfo available; dataPoints updates handled in separate effect
	}, [systemInfo]); // Re-run when systemInfo becomes available

	/**
	 * Update chart when data points change
	 */
	useEffect(() => {
		if (!chartInstanceRef.current || dataPoints.length === 0) {
			return;
		}

		const labels = dataPoints.map((_, index) => {
			if (index === 0) return 'Start';
			if (index === dataPoints.length - 1) return 'Now';
			return '';
		});

		const cpuData = dataPoints.map(p => p.cpuUtilization);
		const memData = dataPoints.map(p => p.memoryUtilization);

		chartInstanceRef.current.data.labels = labels;
		chartInstanceRef.current.data.datasets[0].data = cpuData;
		chartInstanceRef.current.data.datasets[1].data = memData;
		chartInstanceRef.current.update('none');
	}, [dataPoints]);

	// ========================================================================
	// HELPER FUNCTIONS
	// ========================================================================

	const _formatBytes = (gb: number | undefined): string => {
		if (gb === undefined || gb === null) {
			return 'N/A';
		}
		if (gb >= 1000) {
			return `${(gb / 1024).toFixed(2)} TB`;
		}
		return `${gb.toFixed(2)} GB`;
	};

	const getConnectionBadge = () => {
		if (connectionState === ConnectionState.CONNECTED) {
			return <span className="status-badge connected">Connected</span>;
		} else if (connectionState === ConnectionState.CONNECTING) {
			return <span className="status-badge connecting">Connecting...</span>;
		} else {
			return <span className="status-badge disconnected">Disconnected</span>;
		}
	};

	// ========================================================================
	// RENDER
	// ========================================================================

	return (
		<div className="page-system">
			<header className="page-header">
				<h1>System Performance</h1>
				{getConnectionBadge()}
			</header>

		{errorMessage && (
			<div className="error-message">
				<div className="error-icon">⚠️</div>
				<div className="error-content">
					<div className="error-title">Server Error</div>
					<div className="error-text">{errorMessage}</div>
				</div>
			</div>
		)}

		{!systemInfo && !errorMessage && connectionState === ConnectionState.CONNECTED && (
			<div className="loading-message">Loading system information...</div>
		)}

		{!systemInfo && !errorMessage && connectionState !== ConnectionState.CONNECTED && (
			<div className="disconnected-message">
				<p>Not connected to server. Please connect to view system performance.</p>
			</div>
		)}

			{systemInfo && (
				<div className="content-grid">
					{/* System Overview */}
					<section className="info-section">
						<h2>System Overview</h2>
						<div className="info-grid">
							<div className="info-item">
								<span className="info-label">Platform</span>
								<span className="info-value">{systemInfo.platform || 'N/A'}</span>
							</div>
							<div className="info-item">
								<span className="info-label">CPU Cores</span>
								<span className="info-value">{systemInfo.nCPUCores || 'N/A'}</span>
							</div>
							<div className="info-item">
								<span className="info-label">Current CPU Usage</span>
								<span className="info-value">{systemInfo.cpuUtilization?.toFixed(1) || 'N/A'}%</span>
							</div>
							<div className="info-item">
								<span className="info-label">Current Memory Usage</span>
								<span className="info-value">{systemInfo.memoryUtilization?.toFixed(1) || 'N/A'}%</span>
							</div>
						</div>
					</section>

					{/* CPU/Memory Utilization Chart */}
					<section className="chart-section">
						<h2>CPU & Memory Utilization Over Time</h2>
						<div className="chart-container">
							<canvas ref={chartRef} className="chart-canvas"></canvas>
						</div>
					</section>
				</div>
			)}
		</div>
	);
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
	const chartGreen = getColor('--vscode-charts-green', '#4caf50');
	const foreground = getColor('--vscode-descriptionForeground', 'rgba(204, 204, 204, 0.6)');
	const gridColor = 'rgba(128, 128, 128, 0.1)';

	return {
		blue: chartBlue,
		blueFill: hexToRgba(chartBlue, 0.15),
		green: chartGreen,
		greenFill: hexToRgba(chartGreen, 0.15),
		foreground,
		gridColor,
		tooltipBg: getColor('--vscode-editorWidget-background', '#ffffff'),
		tooltipBorder: getColor('--vscode-widget-border', '#e0e0e0'),
		tooltipForeground: getColor('--vscode-editorWidget-foreground', '#1e1e1e'),
		white: '#ffffff'
	};
};

