/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * CallToolResult → JSON payload. Tool results arrive as
 * [{ type: 'text', text: '<json>' }] (the Python side does not emit
 * structuredContent); failures are either host-level (isError) or in-band
 * envelopes ({ ok: false, error_type, message }).
 */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly errorType?: string
	) {
		super(message);
		this.name = 'ToolError';
	}
}

export function friendlyToolError(payload: Record<string, unknown>): string {
	if (payload.error_type === 'TraceExpired') {
		return 'This trace has aged out of the DVR retention window (7 days dev / 30 days deploy).';
	}
	if (payload.error_type === 'NotFound') {
		return 'No recorded trace was found at this position.';
	}
	return (typeof payload.message === 'string' && payload.message) || 'tool call failed';
}

export function parseToolJson(result: unknown): Record<string, unknown> {
	const res = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	const text = (res.content ?? []).find((c) => c.type === 'text')?.text;
	if (res.isError) throw new ToolError(text || 'tool call failed');
	if (!text) throw new ToolError('malformed tool result (missing text content)');
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new ToolError('malformed tool result (not JSON)');
	}
	if (payload.ok !== true) {
		const errorType = typeof payload.error_type === 'string' ? payload.error_type : undefined;
		throw new ToolError(friendlyToolError(payload), errorType);
	}
	return payload;
}
