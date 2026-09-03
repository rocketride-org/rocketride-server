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

/** Runs one task at a time, in call order. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Creates a queue that runs tasks one at a time, in the order they were
 * submitted.
 *
 * Written for work guarded by a single shared flag: with two calls in flight,
 * whichever finishes first clears the flag while the other is still running,
 * so the guard silently stops guarding. Serializing removes the overlap.
 *
 * A task that rejects does not stop the queue — the next task still runs, and
 * the rejection is delivered only to that task's own caller.
 */
export function createSerialQueue(): SerialQueue {
	let tail: Promise<void> = Promise.resolve();

	return <T>(task: () => Promise<T>): Promise<T> => {
		// Run after the current tail settles, whether it resolved or rejected.
		const result = tail.then(task, task);
		// Swallow on the queue's copy only; `result` keeps the rejection for the
		// caller, and an unobserved queue rejection would be an unhandled one.
		tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};
}
