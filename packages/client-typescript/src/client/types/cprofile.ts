/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
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
 * Type definitions for cProfile process profiling DAP commands.
 *
 * These types correspond to the responses from rrext_cprofile_* commands
 * returned by CProfileManager on the server.
 */

// =============================================================================
// CPROFILE RESPONSE TYPES
// =============================================================================

/** Response from rrext_cprofile_status and rrext_cprofile_start. */
export interface CProfileStatusResponse {
	/** Whether profiling is currently active. */
	active?: boolean;
	/** 'started' or 'error' (from start command). */
	status?: string;
	/** Connection that owns the active session. */
	owner: string | null;
	/** Human-readable session name. */
	session: string | null;
	/** Current runtime in seconds (if active). */
	runtime: number | null;
	/** Unix timestamp when profiling started (from start command). */
	start_time?: number;
	/** Whether a completed report is available (if inactive). */
	has_report?: boolean;
	/** Error message (if status is 'error'). */
	message?: string;
}

/** Response from rrext_cprofile_stop. */
export interface CProfileStopResponse {
	/** 'completed' or 'error'. */
	status: string;
	/** Session name that was stopped. */
	session?: string;
	/** Total profiling duration in seconds. */
	runtime?: number;
	/** Error message (if status is 'error'). */
	message?: string;
	/** Owner info (on ownership mismatch error). */
	owner?: string;
}

/** Response from rrext_cprofile_report. */
export interface CProfileReportResponse {
	/** Full pstats-formatted text report. */
	report: string;
}

// =============================================================================
// CPROFILE TREE TYPES (for flame graph / sunburst / icicle visualisations)
// =============================================================================

/** A single node in the hierarchical call tree returned by rrext_cprofile_report_tree. */
export interface CProfileTreeNode {
	/** Function name. */
	name: string;
	/** Source filename. */
	file: string;
	/** Source line number. */
	line: number;
	/** Number of calls from the parent context. */
	ncalls: number;
	/** Total time spent in this function (excluding sub-calls). */
	tottime: number;
	/** Cumulative time spent in this function (including sub-calls). */
	cumtime: number;
	/** Child function calls. */
	children: CProfileTreeNode[];
}

/** Response from rrext_cprofile_report_tree. */
export interface CProfileReportTreeResponse {
	/** Root node of the call tree (synthetic '<root>' wrapper). */
	tree: CProfileTreeNode | null;
	/** Total cumulative time across all profiled functions. */
	total_time: number;
	/** Total number of function calls recorded. */
	total_calls: number;
	/** Error message if no data is available. */
	error?: string;
}
