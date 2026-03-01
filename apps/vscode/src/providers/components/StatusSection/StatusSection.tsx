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
import { TaskStatus } from '../../../shared/types';
import { CompletionsChart } from './CompletionsChart';
import { ChartStats, StatusDataPoint, TimeRange } from './types';
import { StatusFooter } from './StatusFooter';

/**
 * StatusSection - Completions Chart & Stats
 *
 * Manages data collection and renders the completions chart and stats footer.
 * The header/status-line is now rendered by PageStatus above the tab bar.
 *
 * Features:
 * - 1-second sampling interval
 * - 600 data points (10 minutes of history)
 * - Automatic reset detection when pipeline restarts
 */

interface StatusSectionProps {
	taskStatus: TaskStatus | undefined;
	currentElapsed: number;
}

export const StatusSection: React.FC<StatusSectionProps> = ({
	taskStatus,
	currentElapsed
}) => {
	// State
	const [dataPoints, setDataPoints] = useState<StatusDataPoint[]>([]);
	const [timeRange, setTimeRange] = useState<TimeRange>('1min');
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

	return (
		<>
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
		</>
	);
};
