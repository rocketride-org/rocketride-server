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
// GRAPH - LOAD SLOT (what a document asks its editor to hold, taken exactly once)
// =============================================================================
//
// A connection document asks its run surface to put text in the editor (a History
// load, an Ask preview, a label preview) and sometimes to run it. The request lives
// in the DOCUMENT, which stays mounted, and the surface TAKES it: once taken it is
// gone, so a surface that mounts again (the connection came back, the tab was
// re-created) finds nothing to replay. Nothing here runs by itself later.
// =============================================================================

/** Text for the editor, and whether to run it straight away. */
export interface ILoadRequest {
	text: string;
	run: boolean;
}

/** A one-request mailbox: what is put is taken exactly once. */
export interface ILoadSlot {
	/**
	 * Leave a request, replacing one that was not taken yet.
	 *
	 * @param request - The text and whether to run it.
	 * @returns The request's sequence number (1, 2, ...), for the host to re-render on.
	 */
	put(request: ILoadRequest): number;
	/**
	 * Take the request.
	 *
	 * @returns It, once; null when there is none or it was already taken.
	 */
	take(): ILoadRequest | null;
}

/**
 * Create an empty slot.
 *
 * @returns The slot.
 */
export function createLoadSlot(): ILoadSlot {
	let pending: ILoadRequest | null = null;
	let seq = 0;
	return {
		put(request) {
			pending = { text: request.text, run: request.run };
			seq += 1;
			return seq;
		},
		take() {
			const request = pending;
			pending = null;
			return request;
		},
	};
}
