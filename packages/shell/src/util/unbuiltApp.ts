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

/**
 * Why an app the manifest omits has nothing to serve, read off its version rail.
 *
 * The manifest lists an app only once one of its versions has a finished
 * build, so an app whose every build failed reads as "App not found". The
 * rail, which only the developer org sees in full, tells the two apart.
 */

/** The rail fields this module reads (a subset of `listDeployments` rows). */
export interface RailRow {
	registryVersion: number;
	buildStatus: string;
	state?: string;
}

/** The error-screen copy for an app with no working build. */
export interface UnbuiltAppText {
	title: string;
	message: string;
}

/**
 * Explain an app that has versions but no working build.
 *
 * @param appId - The app id the shell could not resolve.
 * @param rail - The app's version rail, newest first.
 * @returns The screen copy, or null when the rail is empty or a version has
 *          a working build (legacy rows carry no build word and count as built).
 */
export function explainUnbuiltApp(appId: string, rail: readonly RailRow[]): UnbuiltAppText | null {
	// The same failure rule as the SDK's waitForAppBuild.
	const failed = (r: RailRow): boolean => r.buildStatus === 'failed' || r.state === 'failed';
	const newest = rail[0];
	if (!newest || rail.some((r) => !failed(r) && (r.buildStatus === 'ok' || r.buildStatus === ''))) return null;
	const v = newest.registryVersion;
	if (failed(newest)) {
		return {
			title: `No working build of ${appId}`,
			message: `This app has no working build yet, so there is nothing to open. Its latest version, v${v}, failed its server build. To see why, run “rocketride deploy log ${appId} ${v}”.`,
		};
	}
	return {
		title: `${appId} is still building`,
		message: `This app has no finished build yet. Version v${v} is still building on the server (${newest.buildStatus}). Reload this page once the build finishes.`,
	};
}
