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

/**
 * Task State Enumeration
 * 
 * Matches the backend TASK_STATE enum for consistent state representation
 * across the frontend and backend systems. These states represent the complete
 * lifecycle of a pipeline task from initialization to completion.
 * 
 * State Transitions:
 * NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED/CANCELLED
 * 
 * Visual Status Mapping:
 * - NONE, STARTING, COMPLETED, CANCELLED → "Offline" (inactive indicator)
 * - INITIALIZING → "Initializing" (inactive indicator)
 * - RUNNING → "Online" (active indicator)
 * - STOPPING → "Stopping" (warning indicator)
 */
export enum TASK_STATE {
	/** Initial state, no resources allocated yet */
	NONE = 0,

	/** Task is beginning startup sequence */
	STARTING = 1,

	/** Task is initializing resources and preparing to run */
	INITIALIZING = 2,

	/** Task is actively executing and processing data */
	RUNNING = 3,

	/** Task is gracefully shutting down and cleaning up */
	STOPPING = 4,

	/** Task has completed successfully and resources are cleaned up */
	COMPLETED = 5,

	/** Task was cancelled before completion */
	CANCELLED = 6
}

/**
 * Represents flow data for pipeline execution tracking.
 * Contains information about the total number of pipes and their associated data.
 */
export interface FlowData {
	/** Total number of pipes in the pipeline flow */
	totalPipes: number;

	/** 
	 * Mapping of pipe numbers to their associated string data.
	 * Key: pipe number (identifier)
	 * Value: array of strings associated with that pipe
	 */
	byPipe: Record<number, string[]>;
}

/**
 * Basic pipeline definition containing identification and stage information.
 * Represents a simplified view of a pipeline for execution tracking.
 */
export interface Pipeline {
	/** Unique numeric identifier for the pipeline */
	id: number;

	/** Array of stage names that make up this pipeline's execution flow */
	stages: string[];
}

/**
 * Endpoint configuration information for external services contained in the notes field of TaskStatus.
 */
export interface EndpointInfo {
	'button-text'?: string;  // e.g., "Chat now", "Open Dropper" (optional for webhook)
	'button-link'?: string;  // URL to open (optional for webhook)
	'url-text': string;      // e.g., "Chat interface URL", "Webhook Endpoint"
	'url-link': string;      // The actual URL
	'auth-text': string;     // e.g., "Public Authorization Key", "Secret Key"
	'auth-key': string;      // The actual key
	'token-text'?: string;   // e.g., "Private Token" (optional)
	'token-key'?: string;    // The actual token (optional)
}

/**
 * Comprehensive status information for a pipeline task execution.
 * Tracks progress, performance metrics, and execution state throughout the task lifecycle.
 */
export interface TaskStatus {
	// ============================================================================
	// Basic Task Information
	// ============================================================================

	/** Human-readable name of the task */
	name: string;

	/** Whether the task has finished execution (successfully or with errors) */
	completed: boolean;

	/** 
	 * Numeric state code representing the current execution state.
	 * Specific values depend on the task implementation.
	 */
	state: TASK_STATE;

	/** Current status description (e.g., "running", "completed", "failed") */
	status: string;

	/** Is there currently a debugger attached */
	debuggerAttached: boolean;

	// ============================================================================
	// Timing Information
	// ============================================================================

	/** Unix timestamp (milliseconds) when the task started execution */
	startTime: number;

	/** Unix timestamp (milliseconds) when the task completed (0 if still running) */
	endTime: number;

	// ============================================================================
	// Messages and Notifications
	// ============================================================================

	/** Array of warning messages encountered during execution */
	warnings: string[];

	/** Array of error messages encountered during execution */
	errors: string[];

	/** Array of informational notes about the task execution */
	notes: Array<string | EndpointInfo>;

	// ============================================================================
	// Current Processing State
	// ============================================================================

	/** Name or identifier of the object currently being processed */
	currentObject: string;

	/** Size in bytes of the object currently being processed */
	currentSize: number;

	// ============================================================================
	// Progress Metrics - Totals
	// ============================================================================

	/** Total size in bytes of all objects to be processed */
	totalSize: number;

	/** Total number of objects to be processed */
	totalCount: number;

	// ============================================================================
	// Progress Metrics - Completed
	// ============================================================================

	/** Total size in bytes of objects that have been successfully processed */
	completedSize: number;

	/** Number of objects that have been successfully processed */
	completedCount: number;

	// ============================================================================
	// Progress Metrics - Failed
	// ============================================================================

	/** Total size in bytes of objects that failed processing */
	failedSize: number;

	/** Number of objects that failed processing */
	failedCount: number;

	// ============================================================================
	// Text Processing Metrics
	// ============================================================================

	/** Size in bytes related to word/text processing operations */
	wordsSize: number;

	/** Count of words processed */
	wordsCount: number;

	// ============================================================================
	// Performance Metrics
	// ============================================================================

	/** Current processing rate in bytes per unit time */
	rateSize: number;

	/** Current processing rate in objects per unit time */
	rateCount: number;

	// ============================================================================
	// Service and Exit Information
	// ============================================================================

	/** Whether the associated service is currently running */
	serviceUp: boolean;

	/** Exit code of the task process (0 for success, non-zero for errors) */
	exitCode: number;

	/** Human-readable exit message describing the final task state */
	exitMsg: string;

	// ============================================================================
	// Optional Extended Data
	// ============================================================================

	/**
	 * Optional task resource utilization metrics.
	 * User-facing metrics for monitoring CPU, memory, and GPU usage.
	 * CPU percentages are normalized to 0-100% range across all platforms.
	 */
	metrics?: {
		// Current snapshot
		/** Current CPU utilization percentage (normalized 0-100%, per-process) */
		cpu_percent?: number;
		
		/** Current CPU memory (RAM) usage in megabytes (per-process) */
		cpu_memory_mb?: number;
		
		/** Current GPU memory (VRAM) usage in megabytes (per-process) */
		gpu_memory_mb?: number;
		
		// Peak values
		/** Peak CPU utilization percentage during task execution */
		peak_cpu_percent?: number;
		
		/** Peak CPU memory usage in megabytes during task execution */
		peak_cpu_memory_mb?: number;
		
		/** Peak GPU memory usage in megabytes during task execution */
		peak_gpu_memory_mb?: number;
		
		// Average values
		/** Average CPU utilization percentage over task lifetime */
		avg_cpu_percent?: number;
		
		/** Average CPU memory usage in megabytes over task lifetime */
		avg_cpu_memory_mb?: number;
		
		/** Average GPU memory usage in megabytes over task lifetime */
		avg_gpu_memory_mb?: number;
	};

	/**
	 * Optional task token usage tracking (user-facing billing).
	 * 
	 * Behavior:
	 *   - Values are CUMULATIVE from when monitoring starts
	 *   - Updated in real-time every 250ms as metrics are sampled
	 *   - Preserved when monitoring stops (frozen at final values)
	 *   - RESET to 0.0 when start_monitoring() is called for a new session
	 */
	tokens?: {
		/** Cumulative CPU utilization tokens charged since monitoring started */
		cpu_utilization?: number;
		
		/** Cumulative CPU memory tokens charged since monitoring started */
		cpu_memory?: number;
		
		/** Cumulative GPU memory tokens charged since monitoring started */
		gpu_memory?: number;
		
		/** Total cumulative tokens charged (cpu_utilization + cpu_memory + gpu_memory) since monitoring started */
		total?: number;
	};

	/** Optional flow data for pipeline-specific tasks */
	pipeflow?: FlowData;

	/** 
	 * Optional host identifier where the task is running.
	 * This may be added by the debugger for distributed pipeline debugging.
	 */
	host?: string;
}
