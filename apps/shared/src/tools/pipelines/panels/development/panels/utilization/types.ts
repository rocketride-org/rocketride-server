// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Types for the Status component — data points, time ranges, and chart stats.
 *
 * Ported from vscode StatusSection/types.ts.
 */

export interface StatusDataPoint {
	timestamp: number;
	totalDelta: number;
	failedDelta: number;
	cpuPercent?: number;
	cpuMemoryMb?: number;
	gpuMemoryMb?: number;
}

export type TimeRange = '1min' | '5min' | '15min' | 'all';

export interface ChartStats {
	current: number;
	average: number;
	peak: number;
	minimum: number;
	duration: number;
}
