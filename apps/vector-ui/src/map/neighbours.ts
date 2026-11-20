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
// MAP - NEIGHBOUR REQUESTS (one at a time, newest wins)
// =============================================================================
//
// Clicking through points fast must not queue a `neighbors` call per click: the
// store answers one at a time (BUSY otherwise). So one request runs; while it
// runs only the NEWEST waiting request is kept (older waiting ones settle
// "superseded"), and a request whose answer arrives after a newer one was made
// settles "superseded" too, so a stale list is never shown.
// =============================================================================

/** How a request settled. */
export type LatestOutcome<O> = { status: 'done'; value: O } | { status: 'superseded' } | { status: 'failed'; error: unknown };

/** The queue. */
export interface ILatestQueue<I, O> {
	request(input: I): Promise<LatestOutcome<O>>;
	/** Settle anything waiting as superseded and refuse further requests. */
	dispose(): void;
}

interface IEntry<I, O> {
	input: I;
	resolve(outcome: LatestOutcome<O>): void;
}

/**
 * Create a newest-wins queue around an async call.
 *
 * @param run - The call.
 * @returns The queue.
 */
export function createLatestQueue<I, O>(run: (input: I) => Promise<O>): ILatestQueue<I, O> {
	let inFlight: IEntry<I, O> | null = null;
	let waiting: IEntry<I, O> | null = null;
	let disposed = false;

	/** Settle the running entry and start the waiting one, if any. */
	function finish(entry: IEntry<I, O>, outcome: LatestOutcome<O>): void {
		inFlight = null;
		if (waiting !== null && !disposed) {
			entry.resolve({ status: 'superseded' });
			const next = waiting;
			waiting = null;
			start(next);
			return;
		}
		entry.resolve(disposed ? { status: 'superseded' } : outcome);
	}

	/** Run an entry. */
	function start(entry: IEntry<I, O>): void {
		inFlight = entry;
		let call: Promise<O>;
		try {
			call = Promise.resolve(run(entry.input));
		} catch (error) {
			call = Promise.reject(error);
		}
		call.then(
				(value) => finish(entry, { status: 'done', value }),
				(error: unknown) => finish(entry, { status: 'failed', error }),
			);
	}

	return {
		request(input: I): Promise<LatestOutcome<O>> {
			return new Promise<LatestOutcome<O>>((resolve) => {
				if (disposed) {
					resolve({ status: 'superseded' });
					return;
				}
				const entry: IEntry<I, O> = { input, resolve };
				if (inFlight === null) {
					start(entry);
					return;
				}
				waiting?.resolve({ status: 'superseded' });
				waiting = entry;
			});
		},
		dispose(): void {
			disposed = true;
			waiting?.resolve({ status: 'superseded' });
			waiting = null;
		},
	};
}
