// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PROFILER VISUALIZATION — Shared Types
// =============================================================================
//
// Types used across all profiler visualization components (SunburstChart,
// FlameGraph/Icicle, StatsTable, ReportText).
// =============================================================================

// =============================================================================
// TREE NODE
// =============================================================================

/**
 * A single node in the hierarchical call tree returned by the server.
 * Matches the CProfileTreeNode shape from the client SDK.
 */
export interface ProfileTreeNode {
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
	children: ProfileTreeNode[];
}

// =============================================================================
// TREE RESPONSE
// =============================================================================

/**
 * Full response from rrext_cprofile_report_tree.
 */
export interface ProfileTreeResponse {
	/** Root node of the call tree (synthetic '<root>' wrapper). */
	tree: ProfileTreeNode | null;
	/** Total cumulative time across all profiled functions. */
	total_time: number;
	/** Total number of function calls recorded. */
	total_calls: number;
	/** Error message if no data is available. */
	error?: string;
}

// =============================================================================
// UI STATE
// =============================================================================

/** Visualisation style — sunburst (radial) or icicle (rectangular). */
export type VizStyle = 'sunburst' | 'icicle';

/**
 * Breadcrumb entry for flame graph / sunburst drill-down navigation.
 * Records the node the user zoomed into so they can navigate back.
 */
export interface BreadcrumbEntry {
	/** Display label (function name). */
	label: string;
	/** Reference to the tree node (used to restore zoom state). */
	node: ProfileTreeNode;
}

/**
 * Callback signature for when the user selects a node in any visualisation.
 * Used for cross-highlighting between visualisations.
 */
export type OnNodeSelect = (node: ProfileTreeNode | null) => void;

/**
 * Callback signature for when a viz or table re-roots the visualisation
 * (e.g. clicking a table row makes that function the sunburst center).
 */
export type OnRootChange = (node: ProfileTreeNode) => void;
