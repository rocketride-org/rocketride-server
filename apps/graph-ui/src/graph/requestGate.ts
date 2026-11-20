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
// GRAPH - REQUEST GATE (one request at a time per workbench, across its tabs)
// =============================================================================
//
// Every query tab of a workbench has its own runner and graph session, so
// without a gate a workbench could hold several requests on the database at
// once. Apache AGE's node has a pool of four connections, and a request the user
// stopped waiting for keeps its connection until the database finishes it (up
// to the statement timeout), so a few tabs could leave the next request waiting
// for a free connection until it fails as "busy".
//
// The gate lets one request through at a time and counts it until its promise
// SETTLES, not until the user stops waiting. A request asked for while one is in
// flight is refused before anything is sent, with a sentence, as a tool error of
// kind `unavailable` (so a write that was refused here is never reported as one
// that may have been applied). The workbench has one gate for all its tabs; the
// write console has its own.
//
// A refusal that reaches a failure banner (a statement of a batch that met the
// gate taken in the gap before it) is told apart from a node that cannot be
// reached: the node was never asked and the pipeline is running, so it is a
// warning with no "start the pipeline" hint, and it is not a run to record.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';
import type { IFailureNotice } from './failures';
import { splitNotice } from './wording';

/** Which document a gate serves (each has its own). */
export type GateHost = 'workbench' | 'write console';

/**
 * What a request refused by a host's gate says.
 *
 * @param host - The document.
 * @returns The sentence.
 */
export function gateBusyText(host: GateHost): string {
	return `Not sent: an earlier request from this ${host} is still running on the database. ${host === 'workbench' ? 'A workbench' : 'The write console'} sends one request at a time, and one you stopped waiting for counts until the database finishes it. Try again in a moment.`;
}

/** What a request refused by the workbench's gate says. */
export const GATE_BUSY_TEXT = gateBusyText('workbench');

/**
 * The title of a run button that waits for the gate.
 *
 * @param button - The button's own label: Run or Run all in the workbench, Execute or Execute all in the write console.
 * @returns The sentence.
 */
export function gateWaitingTitle(button: 'Run' | 'Run all' | 'Execute' | 'Execute all'): string {
	return `An earlier request is still running on the database; ${button} is available again once it finishes.`;
}

/**
 * Whether a sentence is a gate's refusal (a run that ended with it was never sent).
 *
 * @param text - A run's error text.
 * @returns True for either host's refusal.
 */
export function isGateRefusalText(text: string | null | undefined): boolean {
	return text === GATE_BUSY_TEXT || text === gateBusyText('write console');
}

/** The gate. */
export interface IRequestGate {
	/** Why a request cannot be sent now, or null when the gate is free. */
	busy(): string | null;
	/**
	 * Send a request through the gate.
	 *
	 * @param tool - The tool it calls (named in the refusal).
	 * @param send - Sends it.
	 * @returns Its answer; rejects with its error, or with a "not sent" tool error when the gate is busy.
	 */
	send<T>(tool: string, send: () => Promise<T>): Promise<T>;
	/** Be told when the gate becomes busy or free; returns unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/**
 * Whether an error is the gate's own refusal (nothing was sent).
 *
 * @param error - What a call rejected with.
 * @returns True for the gate's "not sent" tool error.
 */
export function isGateRefusal(error: unknown): boolean {
	return error instanceof ExplorerToolError && error.kind === 'unavailable' && isGateRefusalText(error.message);
}

/**
 * The failure notice of a refusal by the gate: a warning whose headline says nothing was sent, the rest as its hint,
 * and no database text (the database was never asked).
 *
 * @param text - The refusal's sentence (default: the workbench's).
 * @returns The notice.
 */
export function gateRefusalNotice(text: string = GATE_BUSY_TEXT): IFailureNotice {
	const { headline, details } = splitNotice(text);
	return { variant: 'warning', headline, detail: '', verbatim: '', generic: false, hint: details, ignore: false };
}

/**
 * Create a gate.
 *
 * @param host - The document it serves, named in its refusal (default: the workbench).
 * @returns A free gate.
 */
export function createRequestGate(host: GateHost = 'workbench'): IRequestGate {
	const text = gateBusyText(host);
	let inFlight = 0;
	const listeners = new Set<() => void>();
	const notify = (): void => listeners.forEach((listener) => listener());
	return {
		busy: () => (inFlight > 0 ? text : null),
		async send(tool, send) {
			if (inFlight > 0) throw new ExplorerToolError({ kind: 'unavailable', tool, message: text });
			inFlight += 1;
			notify();
			try {
				return await send();
			} finally {
				inFlight -= 1;
				notify();
			}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
