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
		readonly errorType?: string,
	) {
		super(message);
		this.name = 'ToolError';
	}
}

export function friendlyToolError(payload: Record<string, unknown>): string {
	if (payload.error_type === 'TraceExpired') {
		return 'This trace has expired. Run the pipeline again to record a new one.';
	}
	if (payload.error_type === 'NotFound') {
		return 'No recorded trace was found at this position.';
	}
	if (payload.error_type === 'Timeout') {
		return 'The engine did not answer in time. Try again.';
	}
	// Other server messages name tools and arguments; they are for the model, not the card.
	return 'The trace could not be read. Try again.';
}

function tryParseJson(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function parseToolJson(result: unknown): Record<string, unknown> {
	const res = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
	const text = (res.content ?? []).find((c) => c.type === 'text')?.text;
	if (res.isError) {
		// The server also sets isError on every in-band failure ({ok: false, ...}),
		// so read that envelope for its plain message instead of showing raw JSON.
		const envelope = tryParseJson(text);
		if (envelope && envelope.ok === false) {
			throw new ToolError(friendlyToolError(envelope), typeof envelope.error_type === 'string' ? envelope.error_type : undefined);
		}
		throw new ToolError(text || 'tool call failed');
	}
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
