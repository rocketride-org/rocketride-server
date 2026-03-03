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

import { PIPELINE_RESULT } from 'rocketride';

/**
 * Extracts text responses from pipeline result
 *
 * The PIPELINE_RESULT structure uses a dynamic field system where:
 * - result_types maps field names to their data types
 * - Actual data is stored in fields identified by result_types
 * - Fields marked as "text" or "answers" contain displayable strings
 *
 * @param result - Pipeline result from RocketRide API
 * @returns Array of text strings ready for display
 * 
 * @example
 * // If result has: { result_types: { "answers": "answers" }, answers: ["Hello", "World"] }
 * // Returns: ["Hello", "World"]
 */
export const extractTextFromResult = (result: PIPELINE_RESULT): string[] => {
	const textResponses: string[] = [];

	// If we didn't get any result types, make sure they were returned
	if (!result.result_types) {
		textResponses.push('### I don\'t see any answers in there...\nAre you sure you returned them in your pipeline?');
		return textResponses;
	}

	// Iterate through result_types to find fields containing text/answers
	for (const [fieldName, fieldType] of Object.entries(result.result_types)) {
		if (fieldType === 'text' || fieldType === 'answers') {
			const fieldData = result[fieldName];

			if (Array.isArray(fieldData)) {
				// Add all non-empty text items from this field
				textResponses.push(...fieldData.filter(item => typeof item === 'string' && item.trim()));
			} else if (typeof fieldData === 'string' && fieldData.trim()) {
				textResponses.push(fieldData);
			}
		}
	}

	return textResponses;
};