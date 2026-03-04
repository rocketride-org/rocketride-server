// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

import React from 'react';
import { ChartStats } from './types';

interface StatusFooterProps {
	stats: ChartStats;
}

/**
 * Format elapsed time for compact display
 */
const formatElapsedTime = (seconds: number): string => {
	const totalSeconds = Math.floor(seconds);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;
	return `${hours}h ${minutes}m ${remainingSeconds}s`;
};

/**
 * Stats Row Component
 * 
 * Displays summary statistics for the rate chart:
 * current rate, average, peak, minimum, and duration.
 */
export const StatusFooter: React.FC<StatusFooterProps> = ({ stats }) => {
	return (
		<div className="stats-row">
			<div className="stat-item">
				<span className="stat-label">Now:</span>
				<span className="stat-value">{stats.current}/s</span>
			</div>
			<div className="stat-separator"></div>
			<div className="stat-item">
				<span className="stat-label">Avg:</span>
				<span className="stat-value">{stats.average}/s</span>
			</div>
			<div className="stat-separator"></div>
			<div className="stat-item">
				<span className="stat-label">Peak:</span>
				<span className="stat-value">{stats.peak}/s</span>
			</div>
			<div className="stat-separator"></div>
			<div className="stat-item">
				<span className="stat-label">Min:</span>
				<span className="stat-value">{stats.minimum}/s</span>
			</div>
		</div>
	);
};
