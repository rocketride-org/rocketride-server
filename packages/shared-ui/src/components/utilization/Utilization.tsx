// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Status — Completions chart and stats for a pipeline source.
 *
 * A pure renderer over the DVR's reads: useTaskEvents owns the data model
 * (buffer, position, resampling) and delivers both a ready 1-second grid —
 * tracks and dead zones merged into one continuous timeline ending at the
 * DVR position — and the track-scoped Now/Avg/Peak/Min statistics. The
 * range is FIXED at one minute (wider spans are the play bar's job); this
 * component just hands the grid to Chart.js and the stats to the footer.
 * The getters' identities change once per position-second, so both
 * re-derive at 1 Hz regardless of the transport tick rate.
 */

import React, { CSSProperties, useMemo } from 'react';
import { commonStyles } from 'shell/src/themes/styles';
import { CompletionsChart } from './CompletionsChart';
import { StatusFooter } from './StatusFooter';
import type { ChartStats, StatusDataPoint, TimeRange } from './types';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	// Fill the pane's fixed-height body: header on top, stats row pinned to
	// the bottom, chart vertically centered in whatever remains.
	fill: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	},
	chartCenter: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		minHeight: 0,
	},
	chartWidth: {
		width: '100%',
	},
};

// =============================================================================
// TYPES
// =============================================================================

interface UtilizationProps {
	/**
	 * The DVR's chart-series read (useTaskEvents.chartSeries): a 1-second
	 * grid of the last N seconds ending at the position. Identity changes
	 * with the position-second, driving re-derivation.
	 */
	getSeries: (rangeSeconds: number) => StatusDataPoint[];
	/**
	 * The DVR's stats read (useTaskEvents.trackStats): Now/Avg/Peak/Min
	 * scoped to the effective track at the position — NOT the chart's
	 * visible window, which would zero out whenever the run's activity
	 * fell outside the fixed minute.
	 */
	getStats: () => ChartStats;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The chart's fixed range: one minute ending at the DVR position. Wider
 * spans are the play bar's job (zoom + scrub) — a range toggle here was
 * redundant with it.
 */
const CHART_RANGE: TimeRange = '1min';
const CHART_RANGE_SECONDS = 60;

// =============================================================================
// COMPONENT
// =============================================================================

export const Utilization: React.FC<UtilizationProps> = ({ getSeries, getStats }) => {
	// The fixed one-minute grid and the track-scoped stats — re-pulled when
	// the position-second moves (getter identities).
	const dataPoints = useMemo(() => getSeries(CHART_RANGE_SECONDS), [getSeries]);
	const stats = useMemo(() => getStats(), [getStats]);

	return (
		<section style={styles.fill}>
			<div style={commonStyles.sectionHeader}>
				<span style={commonStyles.sectionHeaderLabel}>Performance Metrics</span>
			</div>
			<div style={styles.chartCenter}>
				<div style={styles.chartWidth}>
					<CompletionsChart dataPoints={dataPoints} timeRange={CHART_RANGE} />
				</div>
			</div>
			<StatusFooter stats={stats} />
		</section>
	);
};

export default Utilization;
