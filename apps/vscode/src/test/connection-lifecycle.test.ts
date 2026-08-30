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

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionGenerationController, GenerationOwnedOperationSlot } from '../connection/connection-generation';

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test('only the newest overlapping ready attempt can publish status', async () => {
	const controller = new ConnectionGenerationController();
	const oldCompletion = deferred();
	const newCompletion = deferred();
	const published: string[] = [];

	const oldGeneration = controller.beginAttempt();
	const oldAttempt = oldCompletion.promise.then(() => {
		if (controller.isCurrentAttempt(oldGeneration)) published.push('old');
	});
	const newGeneration = controller.beginAttempt();
	const newAttempt = newCompletion.promise.then(() => {
		if (controller.isCurrentAttempt(newGeneration)) published.push('new');
	});

	oldCompletion.resolve();
	await oldAttempt;
	assert.deepEqual(published, []);

	newCompletion.resolve();
	await newAttempt;
	assert.deepEqual(published, ['new']);
});

test('configuration invalidation suppresses old completion and cancellation while a newer attempt publishes', async () => {
	const controller = new ConnectionGenerationController();
	const oldCompletion = deferred();
	const published: string[] = [];

	const oldGeneration = controller.beginAttempt();
	const oldAttempt = oldCompletion.promise.then(() => {
		if (controller.isCurrentAttempt(oldGeneration)) published.push('old completion');
	});
	const configurationGeneration = controller.invalidateAttempts();
	assert.equal(controller.isCurrentAttempt(oldGeneration), false);
	assert.equal(controller.isCurrentGeneration(configurationGeneration), true);

	const newestGeneration = controller.beginAttempt();
	oldCompletion.resolve();
	await oldAttempt;
	if (controller.isCurrentGeneration(configurationGeneration)) published.push('old cancellation');
	if (controller.isCurrentAttempt(newestGeneration)) published.push('newest');

	assert.deepEqual(published, ['newest']);
});

test('old SDK callbacks stay disabled while the newest attempt is still resolving credentials', () => {
	const controller = new ConnectionGenerationController();
	const oldGeneration = controller.beginAttempt();
	assert.equal(controller.activateAttemptCallbacks(oldGeneration), true);
	assert.equal(controller.isCurrentCallback(controller.callbackGeneration), true);

	const newGeneration = controller.beginAttempt();
	assert.equal(controller.callbackGeneration, undefined);
	assert.equal(controller.isCurrentCallback(oldGeneration), false);

	assert.equal(controller.activateAttemptCallbacks(newGeneration), true);
	assert.equal(controller.isCurrentCallback(newGeneration), true);
	assert.equal(controller.isCurrentCallback(oldGeneration), false);
});

test('SDK event publication stays with the callback-owning connection attempt', () => {
	const controller = new ConnectionGenerationController();
	const published: string[] = [];
	const publishEvent = (event: string) => {
		const generation = controller.callbackGeneration;
		if (!controller.isCurrentCallback(generation)) return;
		published.push(event);
	};

	const oldGeneration = controller.beginAttempt();
	controller.activateAttemptCallbacks(oldGeneration);
	publishEvent('old-before-replacement');

	const newGeneration = controller.beginAttempt();
	publishEvent('old-during-new-credential-resolution');

	controller.activateAttemptCallbacks(newGeneration);
	publishEvent('new-after-callback-activation');

	assert.deepEqual(published, ['old-before-replacement', 'new-after-callback-activation']);
});

test('intentional teardown suppresses stale SDK callbacks and only its current completion publishes disconnect', async () => {
	const controller = new ConnectionGenerationController();
	const oldGeneration = controller.beginAttempt();
	assert.equal(controller.activateAttemptCallbacks(oldGeneration), true);

	const firstDisconnect = controller.invalidateAttempts();
	assert.equal(controller.isCurrentCallback(oldGeneration), false);
	const firstCompletion = deferred();
	const events: string[] = [];
	const firstPublication = firstCompletion.promise.then(() => {
		if (controller.isCurrentGeneration(firstDisconnect)) events.push('first');
	});

	const secondDisconnect = controller.invalidateAttempts();
	firstCompletion.resolve();
	await firstPublication;
	if (controller.isCurrentGeneration(secondDisconnect)) events.push('second');

	assert.deepEqual(events, ['second']);
});

test('callback-owned async publication from an old attempt cannot overwrite the newest result', async () => {
	const controller = new ConnectionGenerationController();
	const slot = new GenerationOwnedOperationSlot();
	const oldCompletion = deferred();
	const published: string[] = [];
	let fetches = 0;

	const oldGeneration = controller.beginAttempt();
	controller.activateAttemptCallbacks(oldGeneration);
	const oldPublication = slot.run(
		oldGeneration,
		() => controller.isCurrentCallback(oldGeneration),
		async () => {
			fetches += 1;
			await oldCompletion.promise;
			return 'old services';
		},
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);

	const newGeneration = controller.beginAttempt();
	controller.activateAttemptCallbacks(newGeneration);
	const newPublication = slot.run(
		newGeneration,
		() => controller.isCurrentCallback(newGeneration),
		async () => {
			fetches += 1;
			return 'new services';
		},
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);
	await newPublication;
	oldCompletion.resolve();
	await oldPublication;

	assert.equal(fetches, 2);
	assert.deepEqual(published, ['new services']);
});

test('clearing a callback-owned slot suppresses old work when the same outer generation reconnects', async () => {
	const controller = new ConnectionGenerationController();
	const slot = new GenerationOwnedOperationSlot();
	const oldCompletion = deferred();
	const generation = controller.beginAttempt();
	controller.activateAttemptCallbacks(generation);
	const published: string[] = [];

	const oldPublication = slot.run(
		generation,
		() => controller.isCurrentCallback(generation),
		async () => {
			await oldCompletion.promise;
			return 'old connection';
		},
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);

	slot.clear();
	const reconnectedPublication = slot.run(
		generation,
		() => controller.isCurrentCallback(generation),
		async () => 'reconnected',
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);
	await reconnectedPublication;
	oldCompletion.resolve();
	await oldPublication;

	assert.deepEqual(published, ['reconnected']);
});

test('a synchronous callback-owned work failure publishes to the active generation', async () => {
	const slot = new GenerationOwnedOperationSlot();
	const failure = new Error('synchronous failure');
	const published: unknown[] = [];

	await slot.run(
		1,
		() => true,
		() => {
			throw failure;
		},
		(outcome) => {
			published.push(outcome);
		}
	);

	assert.deepEqual(published, [{ status: 'rejected', reason: failure }]);
});

test('an ownerless operation never coalesces with another ownerless operation', async () => {
	const slot = new GenerationOwnedOperationSlot();
	const firstCompletion = deferred();
	const published: string[] = [];
	let fetches = 0;

	const first = slot.run(
		undefined,
		() => true,
		async () => {
			fetches += 1;
			await firstCompletion.promise;
			return 'first';
		},
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);
	const second = slot.run(
		undefined,
		() => true,
		async () => {
			fetches += 1;
			return 'second';
		},
		(outcome) => {
			if (outcome.status === 'fulfilled') published.push(outcome.value);
		}
	);

	await second;
	firstCompletion.resolve();
	await first;

	assert.equal(fetches, 2);
	assert.deepEqual(published, ['second']);
});

test('serialized attempt publication cannot let an old filesystem write land after the newest attempt', async () => {
	const controller = new ConnectionGenerationController();
	const oldRead = deferred();
	const writes: string[] = [];

	const oldGeneration = controller.beginAttempt();
	const oldPublication = controller.serializeAttemptPublication(oldGeneration, async (isCurrent) => {
		await oldRead.promise;
		if (isCurrent()) writes.push('old');
	});

	const newGeneration = controller.beginAttempt();
	const newPublication = controller.serializeAttemptPublication(newGeneration, async (isCurrent) => {
		if (isCurrent()) writes.push('new');
	});

	oldRead.resolve();
	await Promise.all([oldPublication, newPublication]);
	assert.deepEqual(writes, ['new']);
});
