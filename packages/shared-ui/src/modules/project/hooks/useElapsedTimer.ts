// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * useElapsedTimer
 *
 * Returns a live-updating elapsed-seconds counter while a pipeline task
 * is actively running. Starts a 1-second interval when the task enters
 * the RUNNING state and automatically stops when the task completes,
 * is cancelled, or the component unmounts.
 */

import { useState, useEffect, useRef } from 'react';
import { TASK_STATE } from '../types';
import type { TaskStatus } from '../types';

// =============================================================================
// Hook
// =============================================================================

export function useElapsedTimer(taskStatus: TaskStatus | null | undefined): number {
	const [currentElapsed, setCurrentElapsed] = useState<number>(0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		// Clear any existing interval before deciding whether to start a new one
		if (intervalRef.current !== null) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}

		const isRunning = taskStatus != null && taskStatus.state === TASK_STATE.RUNNING && taskStatus.startTime > 0 && !taskStatus.completed;

		if (isRunning) {
			const updateElapsed = () => {
				const nowSeconds = Math.floor(Date.now() / 1000);
				const elapsed = nowSeconds - taskStatus.startTime;
				setCurrentElapsed(Math.max(0, elapsed));
			};

			// Compute immediately, then tick every second
			updateElapsed();
			intervalRef.current = setInterval(updateElapsed, 1000);
		} else if (taskStatus?.completed) {
			setCurrentElapsed(0);
		}

		return () => {
			if (intervalRef.current !== null) {
				clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [taskStatus?.completed, taskStatus?.startTime, taskStatus?.state]);

	return currentElapsed;
}
