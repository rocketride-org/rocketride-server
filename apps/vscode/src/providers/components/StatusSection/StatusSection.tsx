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
import { TaskStatus, TASK_STATE } from '../../../shared/types';
import type { EndpointInfo } from '../EndpointInfoModal';
import { StatusHeader } from './StatusHeader';
import { CompletionsChart } from './CompletionsChart';
import { ChartStats, StatusDataPoint, TimeRange } from './types';
import { StatusFooter } from './StatusFooter';

/**
 * Unified Processing Rate & Status Section Component
 * 
 * Manages data collection and state for the status and chart display.
 * Orchestrates the StatusLine, RateChart, and StatsRow child components.
 * 
 * Features:
 * - 1-second sampling interval
 * - 600 data points (10 minutes of history)
 * - Automatic reset detection when pipeline restarts
 * - Optional endpoint action buttons
 * - Run/Stop controls
 */

interface StatusSectionProps {
	taskStatus: TaskStatus | undefined;
	endpointInfo?: EndpointInfo | null;
	onOpenEndpointInfo?: () => void;
	onOpenExternal?: (url: string) => void;
	onRun?: () => void;
	onStop?: () => void;
	host?: string;
}

export const StatusSection: React.FC<StatusSectionProps> = ({
	taskStatus,
	endpointInfo,
	onOpenEndpointInfo,
	onOpenExternal,
	onRun,
	onStop,
	host = ''
}) => {
	// State
	const [dataPoints, setDataPoints] = useState<StatusDataPoint[]>([]);
	const [timeRange, setTimeRange] = useState<TimeRange>('1min');
	const [currentElapsed, setCurrentElapsed] = useState<number>(0);
	const [chartStats, setChartStats] = useState<ChartStats>({
		current: 0,
		average: 0,
		peak: 0,
		minimum: 0,
		duration: 0
	});

	// Refs
	const prevTotalRef = useRef<number>(0);
	const prevFailedRef = useRef<number>(0);
	const intervalRef = useRef<number | null>(null);
	const taskStatusRef = useRef<TaskStatus | undefined>(taskStatus);

	// Constants
	const MAX_DATA_POINTS = 600; // 10 minutes at 1 second intervals

	/**
	 * Keep taskStatusRef in sync with taskStatus prop
	 */
	useEffect(() => {
		taskStatusRef.current = taskStatus;
	}, [taskStatus]);

	/**
	 * Real-Time Elapsed Time Update Effect
	 */
	useEffect(() => {
		if (intervalRef.current !== null) {
			window.clearInterval(intervalRef.current);
			intervalRef.current = null;
		}

		if (taskStatus && !taskStatus.completed && taskStatus.startTime > 0) {
			const updateElapsed = () => {
				const currentTimeSeconds = Math.floor(Date.now() / 1000);
				const elapsed = currentTimeSeconds - taskStatus.startTime;
				const validElapsed = Math.max(0, elapsed);
				setCurrentElapsed(validElapsed);
			};

			updateElapsed();
			intervalRef.current = window.setInterval(updateElapsed, 1000);
		} else if (taskStatus?.completed) {
			setCurrentElapsed(0);
		}

		return () => {
			if (intervalRef.current !== null) {
				window.clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only reset timer on completion state
	}, [taskStatus?.completed, taskStatus?.startTime]);

	/**
	 * Initialize data points with zeros
	 */
	useEffect(() => {
	const initialPoints: StatusDataPoint[] = [];
	const now = Date.now();
	for (let i = MAX_DATA_POINTS - 1; i >= 0; i--) {
		initialPoints.push({
			timestamp: now - (i * 1000),
			totalDelta: 0,
			failedDelta: 0,
			cpuPercent: 0,
			cpuMemoryMb: 0,
			gpuMemoryMb: 0
		});
	}
	setDataPoints(initialPoints);
	}, [MAX_DATA_POINTS]);

	/**
	 * Set up 1-second sampling interval
	 * This runs ONCE on mount and continuously samples data
	 * Uses taskStatusRef to access latest taskStatus without recreating interval
	 */
	useEffect(() => {
		const interval = setInterval(() => {
			const currentTaskStatus = taskStatusRef.current;

		if (!currentTaskStatus) {
			setDataPoints(prev => {
				const newPoint: StatusDataPoint = {
					timestamp: Date.now(),
					totalDelta: 0,
					failedDelta: 0,
					cpuPercent: 0,
					cpuMemoryMb: 0,
					gpuMemoryMb: 0
				};
				const updated = [...prev, newPoint];
				return updated.length > MAX_DATA_POINTS
					? updated.slice(updated.length - MAX_DATA_POINTS)
					: updated;
			});
			return;
		}

			// PIPELINE RESTART DETECTION
			// If the current count is less than our previous count, the pipeline was restarted
			// Reset everything to start fresh
			if (currentTaskStatus.totalCount < prevTotalRef.current || currentTaskStatus.failedCount < prevFailedRef.current) {
				// Reset the baseline counters
				prevTotalRef.current = currentTaskStatus.totalCount;
				prevFailedRef.current = currentTaskStatus.failedCount;

		// Reset the entire data series with zeros
		const now = Date.now();
		const resetPoints: StatusDataPoint[] = [];
		for (let i = MAX_DATA_POINTS - 1; i >= 0; i--) {
			resetPoints.push({
				timestamp: now - (i * 1000),
				totalDelta: 0,
				failedDelta: 0,
				cpuPercent: 0,
				cpuMemoryMb: 0,
				gpuMemoryMb: 0
			});
		}
			setDataPoints(resetPoints);
			return;
			}

		// First time initialization - set baseline without creating a spike
		if (prevTotalRef.current === 0 && prevFailedRef.current === 0) {
			prevTotalRef.current = currentTaskStatus.totalCount;
			prevFailedRef.current = currentTaskStatus.failedCount;
			setDataPoints(prev => {
				const newPoint: StatusDataPoint = {
					timestamp: Date.now(),
					totalDelta: 0,
					failedDelta: 0,
					cpuPercent: currentTaskStatus.metrics?.cpu_percent || 0,
					cpuMemoryMb: currentTaskStatus.metrics?.cpu_memory_mb || 0,
					gpuMemoryMb: currentTaskStatus.metrics?.gpu_memory_mb || 0
				};
				const updated = [...prev, newPoint];
				return updated.length > MAX_DATA_POINTS
					? updated.slice(updated.length - MAX_DATA_POINTS)
					: updated;
			});
			return;
		}

		// Normal delta calculation
		const totalDelta = currentTaskStatus.totalCount - prevTotalRef.current;
		const failedDelta = currentTaskStatus.failedCount - prevFailedRef.current;

		prevTotalRef.current = currentTaskStatus.totalCount;
		prevFailedRef.current = currentTaskStatus.failedCount;

		setDataPoints(prev => {
			const newPoint: StatusDataPoint = {
				timestamp: Date.now(),
				totalDelta,
				failedDelta,
				cpuPercent: currentTaskStatus.metrics?.cpu_percent || 0,
				cpuMemoryMb: currentTaskStatus.metrics?.cpu_memory_mb || 0,
				gpuMemoryMb: currentTaskStatus.metrics?.gpu_memory_mb || 0
			};
			const updated = [...prev, newPoint];
			return updated.length > MAX_DATA_POINTS
				? updated.slice(updated.length - MAX_DATA_POINTS)
				: updated;
		});
		}, 1000);

		return () => clearInterval(interval);
	}, [MAX_DATA_POINTS]); // Only depends on MAX_DATA_POINTS, not taskStatus

	/**
	 * Process endpoint info to replace {host} placeholders
	 */
	const getProcessedButtonLink = (): string | undefined => {
		try {
			if (!endpointInfo?.['button-link'] || !host) {
				return endpointInfo?.['button-link'];
			}
			return endpointInfo['button-link'].replace(/{host}/g, host);
		} catch (error) {
			console.error('Error processing button link:', error);
			return endpointInfo?.['button-link'];
		}
	};

	/**
	 * Determine the run/stop button state and action
	 */
	const getControlButton = () => {
		const state = taskStatus?.state ?? TASK_STATE.NONE;

		// Show "Stop" button for RUNNING and INITIALIZING states
		if (state === TASK_STATE.RUNNING || state === TASK_STATE.INITIALIZING) {
			return {
				label: 'Stop',
				action: onStop,
				disabled: false,
				className: 'action-btn stop-btn'
			};
		}

		// Show enabled "Run" button for NONE, CANCELLED, and COMPLETED states
		if (state === TASK_STATE.NONE || state === TASK_STATE.CANCELLED || state === TASK_STATE.COMPLETED) {
			return {
				label: 'Run',
				action: onRun,
				disabled: false,
				className: 'action-btn run-btn'
			};
		}

		// For all other states (STOPPING, etc), show disabled "Run" button
		return {
			label: 'Run',
			action: onRun,
			disabled: true,
			className: 'action-btn run-btn disabled'
		};
	};

	const controlButton = getControlButton();

	return (
		<section className="status-panel">
			{/* Panel Header with Endpoint Actions */}
			<div className="panel-header">
				<div className="panel-title">Status & Completions</div>
				<div className="panel-actions">
					{endpointInfo && typeof endpointInfo === 'object' && (
						<>
							{endpointInfo['button-text'] && endpointInfo['button-link'] && onOpenExternal && (
								<button
									className="action-btn"
									onClick={() => {
										try {
											const processedLink = getProcessedButtonLink();
											if (processedLink) {
												onOpenExternal(processedLink);
											}
										} catch (error) {
											console.error('Error opening external link:', error);
										}
									}}
								>
									{endpointInfo['button-text']}
								</button>
							)}
							{onOpenEndpointInfo && (
								<button
									className="action-btn secondary"
									onClick={() => {
										try {
											onOpenEndpointInfo();
										} catch (error) {
											console.error('Error opening endpoint info:', error);
										}
									}}
								>
									🔑 Endpoint Info
								</button>
							)}
						</>
					)}
					{/* Run/Stop Control Button */}
					{controlButton.action && (
						<button
							className={controlButton.className}
							onClick={() => {
								if (!controlButton.disabled && controlButton.action) {
									try {
										controlButton.action();
									} catch (error) {
										console.error('Error executing control action:', error);
									}
								}
							}}
							disabled={controlButton.disabled}
						>
							{controlButton.label}
						</button>
					)}
				</div>
			</div>

			{/* Status Line Component */}
			<StatusHeader taskStatus={taskStatus} currentElapsed={currentElapsed} />

		{/* Rate Chart Component */}
		<CompletionsChart
			dataPoints={dataPoints}
			timeRange={timeRange}
			onTimeRangeChange={setTimeRange}
			currentElapsed={currentElapsed}
			onStatsCalculated={setChartStats}
		/>

		{/* Stats Row Component */}
		<StatusFooter stats={chartStats} />
		</section>
	);
};