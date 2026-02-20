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

import React from 'react';
import { TaskStatus, TASK_STATE } from '../../../shared/types';

interface StatusLineProps {
	taskStatus: TaskStatus | undefined;
	currentElapsed: number;
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
 * Get task state display
 */
const getTaskStateDisplay = (state: number): string => {
	switch (state) {
		case TASK_STATE.RUNNING: return 'Running';
		case TASK_STATE.INITIALIZING: return 'Initializing';
		case TASK_STATE.STOPPING: return 'Stopping';
		case TASK_STATE.COMPLETED: return 'Completed';
		case TASK_STATE.CANCELLED: return 'Offline';
		case TASK_STATE.NONE: return 'Offline';
		default: return 'Offline';
	}
};

/**
 * Get the CSS class for the status indicator based on state
 */
const getIndicatorClass = (state: number): string => {
	switch (state) {
		case TASK_STATE.RUNNING: return 'status-indicator';
		case TASK_STATE.INITIALIZING: return 'status-indicator initializing';
		case TASK_STATE.STOPPING: return 'status-indicator stopping';
		case TASK_STATE.COMPLETED: return 'status-indicator completed';
		case TASK_STATE.CANCELLED: return 'status-indicator offline';
		case TASK_STATE.NONE: return 'status-indicator offline';
		default: return 'status-indicator offline';
	}
};

/**
 * Compact Status Line Component
 * 
 * Displays task status, state, elapsed time, and counts in a single compact line.
 */
export const StatusHeader: React.FC<StatusLineProps> = ({ taskStatus, currentElapsed }) => {
	return (
		<div className="status-line">
			<div className="status-badge">
				<div className={taskStatus ? getIndicatorClass(taskStatus.state) : 'status-indicator offline'}></div>
				<span>{taskStatus ? getTaskStateDisplay(taskStatus.state) : 'Offline'}</span>
			</div>
			{taskStatus?.status && (
				<>
					<span className="status-separator">•</span>
					<div className="status-item">
						<span className="status-value">{taskStatus.status}</span>
					</div>
				</>
			)}
			{taskStatus && taskStatus.startTime > 0 && !taskStatus.completed && (
				<>
					<span className="status-separator">•</span>
					<div className="status-item">
						Started <span className="status-value">{formatElapsedTime(currentElapsed)} ago</span>
					</div>
				</>
			)}
			{taskStatus && taskStatus.totalCount > 0 && (
				<>
					<span className="status-separator">•</span>
					<div className="status-item">
						<span className="status-value">{taskStatus.totalCount.toLocaleString()}</span> total
					</div>
					<div className="status-item">
						(<span className="status-value">{taskStatus.completedCount.toLocaleString()}</span> done,{' '}
						<span className="status-value error-count">{taskStatus.failedCount.toLocaleString()}</span> failed)
					</div>
				</>
			)}
		</div>
	);
};
