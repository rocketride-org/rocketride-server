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
	/** An action the call's deadline stopped, or never let start. */
	outOfTime: 'the call ran out of time',
	refGone: (ref: string): string => `${ref} is no longer on the page; read the page again`,
	refUnknown: (ref: string): string => `${ref} is not a ref on this page; read the page again`,
	disabled: 'it is disabled',
	notTextField: 'it is not a text field you can type in; type works on inputs and text areas',
	notSelect: 'it is not a native dropdown; for a custom one, click it, then click the option',
	noOption: (value: string, options: readonly string[]): string => `no option "${value}"; the options are: ${options.join(', ')}`,
	notFound: (seconds: number): string => `not on the page after ${seconds} s`,
	/** Notes on a done action: what the page's dialogs said and how each was answered (a page problem when no action raised it), a held new tab, and what replaced the page under it. */
	alerted: (message: string): string => `the page showed the message "${message}"`,
	confirmed: (message: string): string => `the page asked "${message}" (answered OK)`,
	prompted: (message: string): string => `the page asked for text: "${message}" (cancelled)`,
	newTab: (url: string): string => `the page tried to open ${url} in a new tab, which was not opened`,
	reloaded: 'the page reloaded',
	rebuilt: 'the app rebuilt during this action (a file changed)',
} as const;
