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

/** RocketRide's pipeline builder, whose checkout keeps its own call to action. */
export const PIPE_BUILDER_APP_ID = 'rocketride.pipeBuilder';

/**
 * Label for the button that closes the checkout modal after a grant or
 * hackathon code is redeemed. The modal is shared by every app in the store,
 * so for a store app the label names the app the user goes back to; only the
 * pipeline builder keeps RocketRide's own "Start building".
 *
 * @param appName - The app's display name, as the modal's `appName` prop.
 * @param appId - The app's id, as the modal's `appId` prop, when the host passes it.
 * @returns `Start building` for the pipeline builder, else `Continue to <name>`,
 *   or `Continue` when the name is blank.
 */
export const grantSuccessLabel = (appName: string | undefined, appId?: string): string => {
	if (appId === PIPE_BUILDER_APP_ID) return 'Start building';
	const name = appName?.trim();
	return name ? `Continue to ${name}` : 'Continue';
};
