/**
 * MIT License
 * 
 * Copyright (c) 2026 RocketRide, Inc.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Task Management Types: Comprehensive Status Tracking and Event Management System.
 * 
 * This module defines the complete type system for sophisticated task lifecycle management,
 * real-time status monitoring, and event-driven communication in distributed computational
 * pipeline systems. It provides structured data models for tracking complex task execution
 * states, processing statistics, error management, and pipeline flow visualization.
 */

/**
 * Task lifecycle state enumeration for comprehensive state management.
 * 
 * This enumeration defines all possible states in the task execution lifecycle,
 * providing clear state transitions and enabling proper resource management,
 * error handling, and client notification. Each state represents a distinct
 * phase with specific characteristics and available operations.
 * 
 * Lifecycle Phases:
 * ----------------
 * NONE: Initial state before any resources are allocated or configuration
 *       is processed. Tasks in this state can be safely discarded without
 *       cleanup operations.
 * 
 * STARTING: Resource allocation and initial setup phase. Ports are allocated,
 *           temporary files created, and subprocess preparation occurs.
 * 
 * INITIALIZING: Subprocess has been created and is performing pipeline
 *               initialization. Service interfaces are being established.
 * 
 * RUNNING: Task is operational and processing requests. All interfaces
 *          are available and the pipeline is actively executing.
 * 
 * STOPPING: Graceful shutdown initiated. Subprocess is being terminated
 *           and resources are being cleaned up.
 * 
 * COMPLETED: Task finished successfully. All resources cleaned up and
 *            final status available for client queries.
 * 
 * CANCELLED: Task was terminated before completion. Resources cleaned up
 *            and termination reason available in status.
 * 
 * State Transitions:
 * -----------------
 * Normal execution flow:
 * NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED
 * 
 * Cancellation flow:
 * Any state → STOPPING → CANCELLED
 * 
 * Error handling:
 * Any state → STOPPING → COMPLETED (with error exit code)
 * 
 * Resource Management:
 * -------------------
 * - NONE/COMPLETED/CANCELLED: No active resources requiring cleanup
 * - STARTING/INITIALIZING/RUNNING: Active resources requiring cleanup
 * - STOPPING: Cleanup in progress, resources being deallocated
 * 
 * Client Operations:
 * -----------------
 * - NONE: Configuration and launch operations available
 * - STARTING/INITIALIZING: Status monitoring available
 * - RUNNING: Full debugging and data processing operations available
 * - STOPPING: Limited status monitoring, operations being rejected
 * - COMPLETED/CANCELLED: Status queries only, task cleanup may be initiated
 * 
 * Wait Operations:
 * ---------------
 * Clients can wait for specific state transitions using wait_for_running()
 * and similar methods. State transitions trigger event notifications to
 * all subscribed monitoring clients.
 */
export enum TASK_STATE {
	/** Initial state - no resources allocated */
	NONE = 0,

	/** Resource allocation and subprocess preparation */
	STARTING = 1,

	/** Subprocess initialization and service startup */
	INITIALIZING = 2,

	/** Operational state - processing requests */
	RUNNING = 3,

	/** Graceful shutdown and resource cleanup in progress */
	STOPPING = 4,

	/** Successful completion - resources cleaned up */
	COMPLETED = 5,

	/** Terminated before completion - resources cleaned up */
	CANCELLED = 6
}

/**
 * Pipeline component execution flow tracking and visualization model.
 * 
 * This model provides detailed tracking of pipeline component execution flow,
 * enabling real-time visualization of which components are currently executing
 * in each pipeline instance. It supports complex pipeline architectures with
 * multiple concurrent execution paths and nested component hierarchies.
 * 
 * Flow Tracking Features:
 * ----------------------
 * - Multi-pipeline execution tracking with per-instance component stacks
 * - Real-time component entry/exit monitoring for performance analysis
 * - Visual pipeline flow representation for debugging and monitoring
 * - Component execution depth tracking for nested pipeline architectures
 * - Concurrent execution visibility across multiple pipeline instances
 * 
 * Data Structure:
 * --------------
 * totalPipes: Total number of concurrent pipeline execution instances
 * byPipe: Dictionary mapping pipeline instance IDs to component execution stacks
 * 
 * Component Stack Behavior:
 * ------------------------
 * Each pipeline instance maintains a stack of currently executing components:
 * - Component entry pushes component name onto the stack
 * - Component exit pops component name from the stack
 * - Stack depth indicates nesting level of component execution
 * - Empty stack indicates pipeline instance is idle or completed
 * 
 * Visualization Applications:
 * --------------------------
 * - Real-time pipeline execution diagrams showing active components
 * - Performance analysis identifying bottlenecks and execution patterns
 * - Debugging support for component-level execution tracing
 * - Monitoring dashboards displaying pipeline health and activity
 * 
 * Concurrent Execution Support:
 * ----------------------------
 * Multiple pipeline instances can execute simultaneously, each maintaining
 * independent component execution stacks. This enables complex parallel
 * processing scenarios with full visibility into each execution path.
 * 
 * Example Flow Tracking:
 * ---------------------
 * Pipeline 0: ['source', 'transform', 'filter'] - Currently in filter component
 * Pipeline 1: ['source', 'transform']           - Currently in transform component
 * Pipeline 2: []                                - Idle or completed
 */
export interface TASK_STATUS_FLOW {
	/** Total number of concurrent pipeline execution instances */
	totalPipes: number;

	/** Component execution stacks by pipeline instance ID */
	byPipe: Record<number, string[]>;
}

/**
 * Comprehensive task status model with real-time processing statistics and metrics.
 * 
 * This model provides complete task execution status including processing statistics,
 * error tracking, performance metrics, resource usage, and operational state.
 * It serves as the central status repository for task monitoring, client updates,
 * and administrative dashboards.
 * 
 * Status Categories:
 * -----------------
 * - Job Information: Basic task identification and lifecycle status
 * - Processing Statistics: Counts, sizes, rates, and completion metrics
 * - Error Management: Error and warning tracking with message history
 * - Resource Monitoring: Service health and operational state
 * - Performance Metrics: Processing rates and resource utilization
 * - Pipeline Tracking: Component execution flow and pipeline visualization
 * 
 * Real-Time Updates:
 * -----------------
 * Status is updated in real-time as the task processes data and progresses
 * through its lifecycle. Updates are broadcast to subscribed clients based
 * on their EVENT_TYPE subscriptions, enabling responsive monitoring and
 * debugging interfaces.
 * 
 * Buffer Management:
 * -----------------
 * Error and warning lists maintain recent message history with automatic
 * buffer limits to prevent memory growth in long-running tasks. Trace
 * buffers preserve debugging information while controlling resource usage.
 * 
 * Metrics Integration:
 * -------------------
 * Processing statistics and performance metrics are continuously updated
 * to provide real-time visibility into task performance, throughput,
 * and resource utilization patterns.
 * 
 * Client Integration:
 * ------------------
 * Status information is serialized and broadcast to monitoring clients,
 * debugging interfaces, and administrative dashboards. Different client
 * types receive filtered status updates based on their subscription preferences.
 */
export interface TASK_STATUS {
	// Job Information and Lifecycle Status

	/** Human-readable task name derived from pipeline source component */
	name: string;

	/** Unique identifier for the project associated with the task */
	project_id: string;

	/** Source component to execute */
	source: string;

	/** Task completion flag - true when task has finished execution */
	completed: boolean;

	/** Current task lifecycle state from TASK_STATE enumeration */
	state: number;

	/** Task start timestamp (Unix time) for duration calculation */
	startTime: number;

	/** Task completion timestamp (Unix time) for duration calculation */
	endTime: number;

	/** Debugger attachment status */
	debuggerAttached: boolean;

	// Current Status and Operational Messages

	/** Current status message describing task activity and progress */
	status: string;

	// Error and Warning Management with History

	/** Warning message history (limited to 50 recent entries) */
	warnings: string[];

	/** Error message history (limited to 50 recent entries) */
	errors: string[];

	// Current Processing Context

	/** Name/identifier of the item currently being processed */
	currentObject: string;

	/** Size in bytes of the item currently being processed */
	currentSize: number;

	// Status Notes and Contextual Information

	/** Contextual notes and information for status display */
	notes: (string | Record<string, unknown>)[];

	// Comprehensive Processing Statistics

	/** Total size in bytes of all items to be processed */
	totalSize: number;

	/** Total count of all items to be processed */
	totalCount: number;

	/** Total size in bytes of successfully processed items */
	completedSize: number;

	/** Total count of successfully processed items */
	completedCount: number;

	/** Total size in bytes of items that failed processing */
	failedSize: number;

	/** Total count of items that failed processing */
	failedCount: number;

	/** Total size in bytes of extracted/processed text content */
	wordsSize: number;

	/** Total count of words extracted/processed from content */
	wordsCount: number;

	// Real-Time Processing Rates

	/** Current processing rate in bytes per second (instantaneous) */
	rateSize: number;

	/** Current processing rate in items per second (instantaneous) */
	rateCount: number;

	// Service Health and Operational State

	/** Service operational status - true when ready to process requests */
	serviceUp: boolean;

	// Task Termination Information

	/** Process exit code - 0 for success, non-zero for errors */
	exitCode: number;

	/** Exit message providing details about task termination */
	exitMessage: string;

	// Pipeline Component Execution Flow Tracking

	/** Pipeline component execution flow and visualization data */
	pipeflow: TASK_STATUS_FLOW;

	// Resource Utilization Metrics

	/** Real-time resource utilization metrics (CPU normalized to 0-100%, memory in MB, GPU memory in MB) */
	metrics: TASK_METRICS;

	// Token Usage

	/** Cumulative token usage for CPU, memory, GPU (100 tokens = $1.00) */
	tokens: TASK_TOKENS;
}

/**
 * Task token usage tracking (user-facing billing).
 * 
 * Behavior:
 *   - Values are CUMULATIVE from when monitoring starts
 *   - Updated in real-time every 250ms as metrics are sampled
 *   - Preserved when monitoring stops (frozen at final values)
 *   - RESET to 0.0 when start_monitoring() is called for a new session
 */
export interface TASK_TOKENS {
	/** Cumulative CPU utilization tokens charged since monitoring started */
	cpu_utilization: number;

	/** Cumulative CPU memory tokens charged since monitoring started */
	cpu_memory: number;

	/** Cumulative GPU memory tokens charged since monitoring started */
	gpu_memory: number;

	/** Total cumulative tokens charged (cpu_utilization + cpu_memory + gpu_memory) since monitoring started */
	total: number;
}

/**
 * Task resource utilization metrics.
 * 
 * User-facing metrics for monitoring CPU, memory, and GPU usage.
 * CPU percentages are normalized to 0-100% range across all platforms.
 */
export interface TASK_METRICS {
	// Current snapshot
	/** Current CPU utilization percentage (normalized 0-100%, per-process) */
	cpu_percent: number;

	/** Current CPU memory (RAM) usage in megabytes (per-process) */
	cpu_memory_mb: number;

	/** Current GPU memory (VRAM) usage in megabytes (per-process) */
	gpu_memory_mb: number;

	// Peak values
	/** Peak CPU utilization percentage during task execution */
	peak_cpu_percent: number;

	/** Peak CPU memory usage in megabytes during task execution */
	peak_cpu_memory_mb: number;

	/** Peak GPU memory usage in megabytes during task execution */
	peak_gpu_memory_mb: number;

	// Average values
	/** Average CPU utilization percentage over task lifetime */
	avg_cpu_percent: number;

	/** Average CPU memory usage in megabytes over task lifetime */
	avg_cpu_memory_mb: number;

	/** Average GPU memory usage in megabytes over task lifetime */
	avg_gpu_memory_mb: number;
}
