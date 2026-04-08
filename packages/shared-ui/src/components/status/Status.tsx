// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Status — Completions chart and stats for a running pipeline.
 *
 * Ported from vscode StatusSection/StatusSection.tsx.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 *
 * Features:
 *   - 1-second sampling interval
 *   - 600 data points (10 minutes of history)
 *   - Automatic reset detection when pipeline restarts
 */

import React, { useState, useEffect, useRef } from 'react';
import type { ITaskStatus } from '../../types/project';
import { commonStyles } from '../../themes/styles';
import { CompletionsChart } from './CompletionsChart';
import { StatusFooter } from './StatusFooter';
import type { ChartStats, StatusDataPoint, TimeRange } from './types';

// =============================================================================
// TYPES
// =============================================================================

interface StatusProps {
	taskStatus: ITaskStatus | null | undefined;
	currentElapsed: number;
	/** When true, the built-in StatusHeader is hidden (caller renders its own). */
	hideHeader?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Maximum number of data points to keep (10 min at 1 s intervals). */
const MAX_DATA_POINTS = 600;

/**
 * Build an array of `count` zero-valued data points ending at `now`.
 */
const buildEmptyPoints = (count: number, now: number): StatusDataPoint[] => {
	const pts: StatusDataPoint[] = [];
	for (let i = count - 1; i >= 0; i--) {
		pts.push({
			timestamp: now - i * 1000,
			totalDelta: 0,
			failedDelta: 0,
			cpuPercent: 0,
			cpuMemoryMb: 0,
			gpuMemoryMb: 0,
		});
	}
	return pts;
};

export const Status: React.FC<StatusProps> = ({ taskStatus, currentElapsed }) => {
	// State
	const [dataPoints, setDataPoints] = useState<StatusDataPoint[]>([]);
	const [timeRange, setTimeRange] = useState<TimeRange>('1min');
	const [chartStats, setChartStats] = useState<ChartStats>({
		current: 0,
		average: 0,
		peak: 0,
		minimum: 0,
		duration: 0,
	});

	// Refs
	const prevTotalRef = useRef<number>(0);
	const prevFailedRef = useRef<number>(0);
	const taskStatusRef = useRef<ITaskStatus | null | undefined>(taskStatus);

	// Keep taskStatusRef in sync with taskStatus prop
	useEffect(() => {
		taskStatusRef.current = taskStatus;
	}, [taskStatus]);

	// Initialize data points with zeros
	useEffect(() => {
		setDataPoints(buildEmptyPoints(MAX_DATA_POINTS, Date.now()));
	}, []);

	// Set up 1-second sampling interval.
	// Runs ONCE on mount and continuously samples data.
	// Uses taskStatusRef to access latest taskStatus without recreating interval.
	useEffect(() => {
		const interval = setInterval(() => {
			const currentTaskStatus = taskStatusRef.current;

			if (!currentTaskStatus) {
				setDataPoints((prev) => {
					const newPoint: StatusDataPoint = {
						timestamp: Date.now(),
						totalDelta: 0,
						failedDelta: 0,
						cpuPercent: 0,
						cpuMemoryMb: 0,
						gpuMemoryMb: 0,
					};
					const updated = [...prev, newPoint];
					return updated.length > MAX_DATA_POINTS ? updated.slice(updated.length - MAX_DATA_POINTS) : updated;
				});
				return;
			}

			// PIPELINE RESTART DETECTION
			// If the current count is less than our previous count, the pipeline was restarted.
			if (currentTaskStatus.totalCount < prevTotalRef.current || currentTaskStatus.failedCount < prevFailedRef.current) {
				prevTotalRef.current = currentTaskStatus.totalCount;
				prevFailedRef.current = currentTaskStatus.failedCount;
				setDataPoints(buildEmptyPoints(MAX_DATA_POINTS, Date.now()));
				return;
			}

			// First time initialization - set baseline without creating a spike
			if (prevTotalRef.current === 0 && prevFailedRef.current === 0) {
				prevTotalRef.current = currentTaskStatus.totalCount;
				prevFailedRef.current = currentTaskStatus.failedCount;
				setDataPoints((prev) => {
					const newPoint: StatusDataPoint = {
						timestamp: Date.now(),
						totalDelta: 0,
						failedDelta: 0,
						cpuPercent: currentTaskStatus.metrics?.cpu_percent || 0,
						cpuMemoryMb: currentTaskStatus.metrics?.cpu_memory_mb || 0,
						gpuMemoryMb: currentTaskStatus.metrics?.gpu_memory_mb || 0,
					};
					const updated = [...prev, newPoint];
					return updated.length > MAX_DATA_POINTS ? updated.slice(updated.length - MAX_DATA_POINTS) : updated;
				});
				return;
			}

			// Normal delta calculation
			const totalDelta = currentTaskStatus.totalCount - prevTotalRef.current;
			const failedDelta = currentTaskStatus.failedCount - prevFailedRef.current;

			prevTotalRef.current = currentTaskStatus.totalCount;
			prevFailedRef.current = currentTaskStatus.failedCount;

			setDataPoints((prev) => {
				const newPoint: StatusDataPoint = {
					timestamp: Date.now(),
					totalDelta,
					failedDelta,
					cpuPercent: currentTaskStatus.metrics?.cpu_percent || 0,
					cpuMemoryMb: currentTaskStatus.metrics?.cpu_memory_mb || 0,
					gpuMemoryMb: currentTaskStatus.metrics?.gpu_memory_mb || 0,
				};
				const updated = [...prev, newPoint];
				return updated.length > MAX_DATA_POINTS ? updated.slice(updated.length - MAX_DATA_POINTS) : updated;
			});
		}, 1000);

		return () => clearInterval(interval);
	}, []);

	return (
		<section>
			<div style={{ ...commonStyles.cardHeader, background: 'none' }}>
				<span style={commonStyles.sectionHeaderLabel}>Performance Metrics</span>
				<div style={commonStyles.toggleGroup}>
					{(['1min', '5min', '15min', 'all'] as TimeRange[]).map((range) => (
						<button key={range} style={commonStyles.toggleButton(timeRange === range)} onClick={() => setTimeRange(range)}>
							{range === '1min' ? '1 min' : range === '5min' ? '5 min' : range === '15min' ? '15 min' : 'All'}
						</button>
					))}
				</div>
			</div>
			<CompletionsChart dataPoints={dataPoints} timeRange={timeRange} onTimeRangeChange={setTimeRange} currentElapsed={currentElapsed} onStatsCalculated={setChartStats} />
			<StatusFooter stats={chartStats} />
		</section>
	);
};

export default Status;
