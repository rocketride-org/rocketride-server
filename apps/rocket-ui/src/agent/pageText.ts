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
// PAGE TEXT — every sentence the agent's app page writes for the model
// =============================================================================

/**
 * The page's problems, failures and notes reach the model through use_app's result. They live here, apart
 * from the logic, so the wording can change in one place.
 */

export const PAGE_TEXT = {
	/** A use that waited behind check_app until its call ran out of time. */
	busy: 'the page was busy (check_app) until the call ran out of time',
	buildFailed: (reason: string | undefined): string => `the app's build failed: ${reason ?? 'no reason given'}`,
	notLoaded: (seconds: number): string => `the app had not loaded after ${seconds} s; the page may still show the loading screen`,
	/** Why a use found no page: it closed (the turn ended, or it left the app earlier). */
	closed: 'this copy of the app is closed',
	previewGone: 'the preview is gone',
	leftApp: 'the page left the app; the next use_app call opens a fresh copy',
	turnEndedWhileStarting: 'the turn ended while the preview was starting',
} as const;
