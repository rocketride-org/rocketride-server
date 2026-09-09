// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Trace Renderer: Tool Lane
//
// Renders control-plane @tool_function invocations (client.tool -> node).
// The engine's data connection emits enter/leave trace events on the pipe the
// call runs on: enter data = { tool, input }, leave data = { durationMs,
// output } (or { durationMs, error } on failure).
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';
import { JsonTree } from '../../json-tree';

// =============================================================================
// TYPES
// =============================================================================

/** Enter-side payload of a tool trace event. */
interface ToolInputData {
	tool?: string;
	input?: unknown;
}

/** Leave-side payload of a tool trace event. */
interface ToolOutputData {
	durationMs?: number;
	output?: unknown;
	error?: string;
}

// =============================================================================
// TYPE GUARD
// =============================================================================

/**
 * Guard for tool-lane trace payloads (either side).
 *
 * @param data - The trace data payload.
 * @returns True when the payload carries tool-call fields.
 */
export function isTool(data: unknown): boolean {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return typeof d.tool === 'string' || typeof d.durationMs === 'number';
}

// =============================================================================
// HELPERS
// =============================================================================

/** Truncate a value's JSON text for a one-line summary. */
function short(value: unknown, maxLen: number = 120): string {
	if (value == null) return '';
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

// =============================================================================
// INPUT (enter side)
// =============================================================================

/**
 * One-line summary for the collapsed input row: `stats({...})`.
 *
 * @param data - Enter-side payload.
 * @returns The summary string.
 */
export function summaryToolInput(data: unknown): string {
	const d = data as ToolInputData;
	// Only ABSENT input (or an empty object) renders as no-args — falsy
	// scalars (0, false, '') are real arguments and must show as such.
	const input = d.input;
	const isEmptyObject = input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input as object).length === 0;
	const args = input === undefined || input === null || isEmptyObject ? '' : short(input);
	return `${d.tool ?? 'tool'}(${args})`;
}

/**
 * Expanded input view: tool name + input tree.
 *
 * @param data - Enter-side payload.
 * @returns The rendered element.
 */
export function renderToolInput(data: unknown): ReactElement {
	const d = data as ToolInputData;
	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Tool</span>
				<span style={RS.kvMono}>{d.tool ?? ''}</span>
			</div>
			<div style={RS.section}>
				<div style={RS.label}>Input</div>
				<div style={RS.sectionContent}>
					<JsonTree data={d.input ?? {}} defaultExpanded={1} />
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// OUTPUT (leave side)
// =============================================================================

/**
 * One-line summary for the collapsed output row: duration + error marker.
 *
 * @param data - Leave-side payload.
 * @returns The summary string.
 */
export function summaryToolOutput(data: unknown): string {
	const d = data as ToolOutputData;
	const duration = d.durationMs != null ? `${d.durationMs} ms` : '';
	if (d.error) return `${duration} · error`.trim();
	return `${duration} · ${short(d.output, 80)}`.trim();
}

/**
 * Expanded output view: duration + output tree (or the error).
 *
 * @param data - Leave-side payload.
 * @returns The rendered element.
 */
export function renderToolOutput(data: unknown): ReactElement {
	const d = data as ToolOutputData;
	return (
		<div>
			{d.durationMs != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Duration</span>
					<span style={RS.kvMono}>{d.durationMs} ms</span>
				</div>
			)}
			{d.error != null ? (
				<div style={RS.section}>
					<div style={RS.label}>Error</div>
					<div style={RS.sectionContent}>
						<div style={RS.textBlock}>{d.error}</div>
					</div>
				</div>
			) : (
				<div style={RS.section}>
					<div style={RS.label}>Output</div>
					<div style={RS.sectionContent}>
						<JsonTree data={d.output ?? {}} defaultExpanded={1} />
					</div>
				</div>
			)}
		</div>
	);
}
