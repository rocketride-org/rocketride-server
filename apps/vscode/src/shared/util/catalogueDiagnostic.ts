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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// SAY WHY THE PALETTE IS EMPTY.
//
// A catalogue that failed and a catalogue that is genuinely empty both render
// as an empty node palette, and the difference is the entire diagnosis:
// "authentication failed" and "the engine loaded zero services" are different
// problems with different fixes. Kept free of `vscode` imports so the decision
// can be tested with node:test, like the other helpers in this folder.

/** The `shell:servicesUpdated` payload fields this looks at. */
export type CataloguePayload = {
	services?: Record<string, unknown>;
	servicesError?: string;
};

/** What the output channel should say about one catalogue update. */
export type CatalogueDiagnostic = {
	level: 'error' | 'warning';
	message: string;
};

/**
 * The error `refreshServices` reports before a connection exists.
 *
 * A state, not a failure: every startup passes through it, once per open
 * editor, before the connection is up. Reporting it at all — worse, at error
 * level — makes it read like the authentication failure this exists to
 * distinguish.
 */
export const NOT_CONNECTED = 'Not connected';

/**
 * Classify one catalogue update.
 *
 * @param payload - The `shell:servicesUpdated` payload.
 * @returns The line to log, or null when there is nothing worth saying.
 * @example
 * catalogueDiagnostic({ services: {}, servicesError: 'HTTP 401' });
 * // => { level: 'error', message: 'Node catalogue unavailable: HTTP 401. …' }
 */
export function catalogueDiagnostic(payload: CataloguePayload): CatalogueDiagnostic | null {
	if (payload.servicesError === NOT_CONNECTED) {
		return null;
	}
	if (payload.servicesError) {
		return {
			level: 'error',
			message: `Node catalogue unavailable: ${payload.servicesError}. The node palette stays empty and .rocketride/services-catalog.json is not written until this is resolved.`,
		};
	}
	if (!payload.services || Object.keys(payload.services).length === 0) {
		return {
			level: 'warning',
			message: 'Node catalogue is empty: the engine returned zero services, so .rocketride/services-catalog.json is not written. One malformed node definition empties the whole catalogue — restart the engine with --trace=Services to see which.',
		};
	}
	return null;
}

/**
 * A reporter that says each thing once.
 *
 * Every editor that becomes ready triggers its own catalogue refresh, so one
 * cause arrives as one event per open editor. The reporter returns a
 * diagnostic only when it differs from the last one it returned; a healthy
 * catalogue (or a disconnect) resets it, so the next failure is reported again.
 *
 * @returns A function taking each payload and returning the line to log, or null.
 * @example
 * const report = createCatalogueReporter();
 * report({ services: {} }); // => { level: 'warning', … }
 * report({ services: {} }); // => null (already said)
 */
export function createCatalogueReporter(): (payload: CataloguePayload) => CatalogueDiagnostic | null {
	let lastMessage: string | null = null;
	return (payload) => {
		const diagnostic = catalogueDiagnostic(payload);
		const message = diagnostic?.message ?? null;
		if (message === lastMessage) {
			return null;
		}
		lastMessage = message;
		return diagnostic;
	};
}
