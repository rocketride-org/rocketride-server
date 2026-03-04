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
 * SAAS-specific task types and constants
 * These types are used by the client-toolchain-saas application
 */

/** Discriminator for the hardware type a task runs on. */
export type ITaskType = 'gpu' | 'cpu';

/**
 * Lifecycle states for a first-run model/dependency download.
 * Used by the SaaS client to show download progress to the user.
 */
export enum INSTALL_STATUS {
	IDLE = 'idle',
	DOWNLOADING = 'downloading',
	COMPLETED = 'completed',
	ERROR = 'error',
}

/**
 * Progress and error information for a single downloadable dependency
 * during a first-run install sequence.
 */
export interface DownloadStatusInfo {
	error: string[];
	name: string;
	status: INSTALL_STATUS;
	timestamp: string;
	trace: string[];
}

/**
 * Full runtime status of a SaaS pipeline task.
 * Contains progress counters, error/warning lists, and first-run download info.
 * Polled from the backend at `TASK_INTERVAL` and rendered in the task-status UI.
 */
export interface ITask {
	type: ITaskType;
	source: string;
	completed: boolean;
	startTime: number;
	endTime: number;
	status: string;
	currentObject: string;
	currentSize: number;
	completedSize: number;
	completedCount: number;
	failedSize: number;
	failedCount: number;
	wordsSize: number;
	wordsCount: number;
	rateSize: number;
	rateCount: number;
	exitCode: number;
	exitMsg: string;
	trace: string[];
	errors: string[];
	warnings: string[];
	notes: Record<string, unknown>[];
	firstRunDownloadStatus: DownloadStatusInfo[];
}

/** Storage key used to persist the task list in the SaaS application. */
export const PID_TASKS = 'PID_TASKS';

/** Polling interval (in milliseconds) for refreshing task statuses from the backend. */
export const TASK_INTERVAL = 1000 * 10; // 10 seconds
