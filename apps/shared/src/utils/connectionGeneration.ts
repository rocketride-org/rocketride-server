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

/**
 * Pure ownership gate for overlapping connection and configuration work.
 */
export class ConnectionGenerationController {
	private generation = 0;
	private activeAttempt?: number;
	private callbackOwner?: number;
	private publicationQueue: Promise<void> = Promise.resolve();

	get activeGeneration(): number | undefined {
		return this.activeAttempt;
	}

	get callbackGeneration(): number | undefined {
		return this.callbackOwner;
	}

	beginAttempt(): number {
		const generation = ++this.generation;
		this.activeAttempt = generation;
		// The prior SDK operation may still complete while the new attempt is
		// resolving credentials. It must not publish through the new generation.
		this.callbackOwner = undefined;
		return generation;
	}

	invalidateAttempts(): number {
		const generation = ++this.generation;
		this.activeAttempt = undefined;
		this.callbackOwner = undefined;
		return generation;
	}

	isCurrentAttempt(generation: number | undefined): boolean {
		return generation !== undefined
			&& generation === this.generation
			&& generation === this.activeAttempt;
	}

	isCurrentGeneration(generation: number): boolean {
		return generation === this.generation;
	}

	/**
	 * Transfer callback publication rights immediately before the matching SDK
	 * lifecycle call. The SDK synchronously supersedes its previous operation.
	 */
	activateAttemptCallbacks(generation: number): boolean {
		if (!this.isCurrentAttempt(generation)) return false;
		this.callbackOwner = generation;
		return true;
	}

	isCurrentCallback(generation: number | undefined): boolean {
		return generation !== undefined
			&& generation === this.callbackOwner
			&& this.isCurrentAttempt(generation);
	}

	/**
	 * Serializes external publication such as filesystem writes. An older
	 * publication either observes lost ownership before writing, or finishes
	 * before the newest publication is allowed to begin.
	 */
	serializeAttemptPublication(
		generation: number,
		publication: (isCurrent: () => boolean) => Promise<void>,
	): Promise<void> {
		const operation = this.publicationQueue.then(async () => {
			if (!this.isCurrentAttempt(generation)) return;
			await publication(() => this.isCurrentAttempt(generation));
		});
		this.publicationQueue = operation.catch(() => undefined);
		return operation;
	}
}

export type GenerationOwnedOutcome<T> =
	| { status: 'fulfilled'; value: T }
	| { status: 'rejected'; reason: unknown };

/**
 * Coalesces work only within a defined generation and publishes only while
 * that generation still owns the result. Ownerless work is never coalesced.
 * A newer generation can start immediately without joining or being cleared
 * by an older task's finally block.
 */
export class GenerationOwnedOperationSlot {
	private active?: {
		generation: number | undefined;
		promise: Promise<void>;
	};

	run<T>(
		generation: number | undefined,
		isCurrent: () => boolean,
		work: () => Promise<T>,
		publish: (outcome: GenerationOwnedOutcome<T>) => void | Promise<void>,
	): Promise<void> {
		const active = this.active;
		if (generation !== undefined && active && active.generation === generation) return active.promise;

		const operation: {
			generation: number | undefined;
			promise: Promise<void>;
		} = {
			generation,
			promise: Promise.resolve(),
		};
		operation.promise = Promise.resolve().then(async () => {
			let outcome: GenerationOwnedOutcome<T>;
			try {
				outcome = { status: 'fulfilled', value: await work() };
			} catch (reason) {
				outcome = { status: 'rejected', reason };
			}
			if (this.active === operation && isCurrent()) await publish(outcome);
		}).finally(() => {
			if (this.active === operation) this.active = undefined;
		});
		this.active = operation;
		return operation.promise;
	}

	clear(): void {
		this.active = undefined;
	}
}
