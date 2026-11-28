// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import type { PIPELINE_RESULT } from 'rocketride';
import type { TextResult } from '../types';

export const NO_RESPONSE_MESSAGE =
	'No response came back. Add a **Return Answers** node after your LLM to send answers to the chat.';

/**
 * Extracts displayable text responses from a RocketRide pipeline result.
 * Handles the dynamic field system where result_types maps field names to types.
 */
export function extractTextFromResult(result: PIPELINE_RESULT): TextResult[] {
	const out: TextResult[] = [];

	if (!result.result_types) {
		out.push({ text: NO_RESPONSE_MESSAGE, key: '' });
		return out;
	}

	for (const [field, type] of Object.entries(result.result_types)) {
		if (type !== 'text' && type !== 'answers') continue;
		const data = result[field];

		if (Array.isArray(data)) {
			data.filter((v) => typeof v === 'string' && v.trim()).forEach((v) => out.push({ text: v, key: field }));
		} else if (typeof data === 'string' && data.trim()) {
			out.push({ text: data, key: field });
		} else if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).answer === 'string') {
			const text = ((data as Record<string, unknown>).answer as string).trim();
			if (text) out.push({ text, key: field });
		}
	}

	return out;
}
