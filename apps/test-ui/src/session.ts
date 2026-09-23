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
// TEST SESSION — Content payload stored in each Document tab
// =============================================================================

import type { TestConfig } from './types';

/** Default test configuration for new sessions. */
export const DEFAULT_CONFIG: TestConfig = {
	pipelines: 32,
	sendsPerPipeline: 50,
	rampUp: 'instant',
	randomDelay: 200,
	killProbability: 2,
	corruptionLevel: 'occasional',
	payloadSize: 'medium',
	payloadType: 'mixed',
};

/**
 * Content stored in each Document tab. Serialized to workspace for persistence.
 */
export interface SessionContent {
	/** Display name for the session (shown in tab). */
	name: string;
	/** Test configuration. */
	config: TestConfig;
	/** Which phases are selected. */
	selectedPhases: string[];
}

/** Create a new session content with defaults. */
export function createSession(name: string): SessionContent {
	return {
		name,
		config: { ...DEFAULT_CONFIG },
		selectedPhases: ['sweep', 'stress', 'flood', 'pipe', 'chaos', 'hammer'],
	};
}
