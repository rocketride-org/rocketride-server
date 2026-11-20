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
// EXPLORER — GENERATIONS (how a late answer is told it is too late)
// =============================================================================
//
// Nothing in the tool protocol cancels a running call, and a client that
// stops waiting only stops listening: the server finishes the work and the
// answer may still arrive. A generation is the guard that makes "stop waiting"
// honest — each run takes a ticket, anything that supersedes the run
// (a newer run, Stop waiting, another connection, a store reset) invalidates
// it, and a result carrying an invalid ticket is dropped instead of landing on
// top of whatever the user is looking at now.
// =============================================================================

/** The right to deliver ONE result, valid until its generation moves on. */
export interface IGenerationTicket {
	/** The generation number this ticket was issued in. */
	readonly id: number;
	/** Whether this ticket's generation is still the current one. */
	isCurrent(): boolean;
}

/** A counter whose tickets expire when it advances. */
export interface IGeneration {
	/** Advance the generation (invalidating every earlier ticket) and issue a ticket for the new one. */
	next(): IGenerationTicket;
	/** Advance the generation without issuing a ticket (e.g. on Stop waiting or a reset). */
	invalidate(): void;
	/** Whether a ticket still belongs to the current generation. */
	isCurrent(ticket: IGenerationTicket): boolean;
	/** The current generation number. */
	current(): number;
}

/**
 * Create a generation counter. Every owner (a query document, a connection, a
 * store) creates its own; none is shared, so one app's reset cannot expire
 * another's tickets.
 *
 * @returns A fresh generation starting at zero.
 */
export function createGeneration(): IGeneration {
	let counter = 0;
	const generation: IGeneration = {
		next(): IGenerationTicket {
			counter += 1;
			const id = counter;
			return { id, isCurrent: () => counter === id };
		},
		invalidate(): void {
			counter += 1;
		},
		isCurrent(ticket: IGenerationTicket): boolean {
			return ticket.id === counter;
		},
		current(): number {
			return counter;
		},
	};
	return generation;
}
