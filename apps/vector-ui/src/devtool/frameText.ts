// =============================================================================
// MIT License
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
// VECTOR-UI - WHAT A DEV-TOOL FRAME SAYS WHEN IT CANNOT SHOW ITS DOCUMENT
// =============================================================================
//
// A frame reaches the server only through the sidebar (the controller). In VS
// Code the sidebar mounts on its first tab select, so a document restored at
// start-up can be on screen with no controller at all: its calls are never
// sent. The frame summons the controller (F11) and says what it waits for,
// never the name of an internal op.
//
// What a connection document (a console, a stored document) shows is decided
// in one plain function (connectionDocState, F13), the first state that
// applies winning:
//
//   1. not-connected   the host says the server connection is down
//   2. waiting         the host has not said yet (not "not connected")
//   3. starting        the controller is being summoned (the quiet grace)
//   4. no-sidebar      nothing answered the summon: open the sidebar
//   5. sign-in         the controller vouches for nobody (F12)
//   6. missing / open  the connection list decides (missingConnectionText)
//
// A document that has already shown its view stays on screen while its
// controller is summoned again (3 and 4): unmounting it would drop its
// directory, chunks and map. Its calls wait for the controller meanwhile, and
// once the summon goes unanswered a banner above it says to open the sidebar.
// Except when nobody is signed in: then it waits for sign-in (5) like any
// document, so a signed-out user never sees the console again.
// =============================================================================

import { ExplorerToolError, readErrorMessage } from 'shared/explorer';
import type { EndpointStatus } from 'shared/explorer';
import type { SignInState } from 'shared/explorer/devtool/frameIdentity';
import type { SummonState } from 'shared/explorer/devtool/summon';

/** What a call no controller ever took says (and what the banner over an open document says once the summon went unanswered). */
export const CONTROLLER_NOT_READY_TEXT = 'Open the Vector Explorer sidebar to connect: this document reaches the server through it.';

/**
 * Whether a failure is the base frame caller's "never sent": it waited for a controller to become ready and none did
 * (kind `timeout`, worded "… was not sent: the tool's controller did not become ready …"). Not to be confused with
 * a call that WAS sent and timed out, which may still have run.
 *
 * @param error - The failure.
 * @returns True for the never-sent failure.
 */
export function isNotSent(error: unknown): boolean {
	return error instanceof ExplorerToolError && error.kind === 'timeout' && / was not sent: /.test(error.message);
}

/**
 * The failure a call reports when no controller ever took it: `unavailable` (it was not sent, so it cannot have run),
 * in words a person can act on.
 *
 * @param tool - The tool it was for.
 * @returns The error.
 */
export function controllerNotReadyError(tool: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'unavailable', tool, message: CONTROLLER_NOT_READY_TEXT });
}

/**
 * What to announce for a failure nobody awaits.
 *
 * @param error - The failure.
 * @param controllerReady - Whether a controller is up.
 * @returns The sentence, or null to say nothing (a dropped, stale call).
 */
export function frameFailureText(error: unknown, controllerReady: boolean): string | null {
	if (error instanceof ExplorerToolError && error.kind === 'stale') return null;
	if (!controllerReady && isNotSent(error)) return CONTROLLER_NOT_READY_TEXT;
	return readErrorMessage(error);
}

/** An empty state's words: a short Title Case title and one sentence (F2). */
export interface IDocText {
	title: string;
	description: string;
}

/** The generic frame (docKey undefined or ''): Rod's shape, one EmptyState; the connection list is the sidebar (F1). */
export const LANDING_TEXT: IDocText = { title: 'Vector Explorer', description: 'Open a connection from the sidebar. Connections are the vector store nodes of your running pipelines.' };

/** Said by a frame whose docKey names no Vector Explorer document (F3). */
export const UNKNOWN_DOCUMENT_TITLE = 'Document not found';

/** What the not-found document says under its title. */
export const UNKNOWN_DOCUMENT_DESCRIPTION = 'This Vector Explorer document no longer exists. Pick a connection in the sidebar.';

/** What a frame knows that decides a connection document's state before the connection list does. */
export interface IDocGates {
	/** The host's `host:connection`: undefined until it published one. */
	host: boolean | undefined;
	/** Where the summon of the controller stands. */
	summon: SummonState;
	/** What the controller says about the account. */
	signIn: SignInState;
}

/** What a connection document shows. */
export type ConnectionDocState = 'not-connected' | 'waiting' | 'starting' | 'no-sidebar' | 'sign-in' | 'missing' | 'open';

/** The words of each state that is not the list's to word (`missing` is missingConnectionText's). */
export const DOC_STATE_TEXT: Record<Exclude<ConnectionDocState, 'missing' | 'open'>, IDocText> = {
	'not-connected': { title: 'Not connected', description: 'Connect to a RocketRide server to open this document.' },
	waiting: { title: 'Waiting for the server connection…', description: 'This document opens once the host reports the server connection.' },
	starting: { title: 'Starting Vector Explorer…', description: 'This document opens as soon as the Vector Explorer sidebar is ready.' },
	'no-sidebar': { title: 'Open the Vector Explorer sidebar to connect', description: 'The sidebar holds the server connection for every Vector Explorer document. This document opens once the sidebar is open.' },
	'sign-in': { title: 'Waiting for sign-in', description: 'Sign in to RocketRide to open this document.' },
};

/**
 * Decide what a connection document shows (F13: the first state that applies wins).
 *
 * @param input - The frame's gates, and what the document knows of its connection.
 * @param input.found - The controller's list holds the document's connection.
 * @param input.opened - The document has shown its view in this frame (it stays through a summon).
 * @returns The state.
 */
export function connectionDocState(input: IDocGates & { found: boolean; opened: boolean }): ConnectionDocState {
	if (input.host === false) return 'not-connected';
	if (input.host === undefined) return 'waiting';
	if (input.summon !== 'ready' && input.opened && input.found) return input.signIn === 'nobody' ? 'sign-in' : 'open';
	if (input.summon === 'summoning') return 'starting';
	if (input.summon === 'unanswered') return 'no-sidebar';
	if (input.signIn === 'nobody') return 'sign-in';
	return input.found ? 'open' : 'missing';
}

/**
 * Whether an open document carries the "open the sidebar" banner: only once the summon went unanswered (F11), never
 * during its quiet grace, and never above an empty state that already says so.
 *
 * @param state - The document's state.
 * @param summon - Where the summon stands.
 * @returns True to show the banner.
 */
export function showsControllerBanner(state: ConnectionDocState, summon: SummonState): boolean {
	return state === 'open' && summon === 'unanswered';
}

/**
 * Why a connection document has no connection to show, once the host, the controller and the account are settled
 * (connectionDocState says `missing`).
 *
 * @param status - The controller's discovery status.
 * @param omitted - Connections the controller left out of a capped list.
 * @returns The empty state's title and description.
 */
export function missingConnectionText(status: EndpointStatus, omitted: number): IDocText {
	if (status === 'idle' || status === 'loading') return { title: 'Looking for this connection', description: 'The sidebar is finding the vector stores of your running pipelines.' };
	if (omitted > 0) {
		return {
			title: 'This connection is not listed here',
			description: `There are too many connections to send them all to this window (${omitted.toLocaleString('en-US')} left out), and this one may be among them; or its pipeline stopped. Pick a connection in the sidebar.`,
		};
	}
	return { title: 'This connection is not listed', description: 'Its pipeline is not running, or it belongs to another account. Pick a connection in the sidebar.' };
}

/** What a document frame shows when its document is not stored (deleted, or never was). */
export const DOCUMENT_GONE_TITLE = 'Document not stored';
