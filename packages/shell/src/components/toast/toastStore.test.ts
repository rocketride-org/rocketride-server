// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { createToastStore, DEFAULT_TOAST_DURATION, ERROR_TOAST_DURATION, MAX_TOASTS } from './toastStore';

test('add assigns unique ids and resolves defaults', () => {
	const store = createToastStore();
	const first = store.add({ message: 'Saved' });
	const second = store.add({ message: 'Failed', variant: 'error' });
	const [a, b] = store.getSnapshot();

	assert.notEqual(first, second);
	assert.equal(a.variant, 'info');
	assert.equal(a.duration, DEFAULT_TOAST_DURATION);
	assert.equal(b.duration, ERROR_TOAST_DURATION);
});

test('an explicit duration wins, and 0 means sticky', () => {
	const store = createToastStore();
	store.add({ message: 'Sticky', duration: 0 });
	store.add({ message: 'Negative', duration: -5 });
	const [sticky, negative] = store.getSnapshot();
	assert.equal(sticky.duration, 0);
	assert.equal(negative.duration, 0);
});

test('keeps at most MAX_TOASTS, dropping the oldest', () => {
	const store = createToastStore();
	for (let index = 0; index < MAX_TOASTS + 2; index++) {
		store.add({ message: `Toast ${index}` });
	}
	const messages = store.getSnapshot().map((toast) => toast.message);
	assert.equal(messages.length, MAX_TOASTS);
	assert.equal(messages[0], 'Toast 2');
	assert.equal(messages[MAX_TOASTS - 1], `Toast ${MAX_TOASTS + 1}`);
});

test('subscribers hear add, remove and clear; no-ops stay silent', () => {
	const store = createToastStore();
	let calls = 0;
	const unsubscribe = store.subscribe(() => {
		calls += 1;
	});

	const id = store.add({ message: 'One' });
	store.remove(id);
	store.remove(id);
	store.clear();
	assert.equal(calls, 2);

	store.add({ message: 'Two' });
	store.clear();
	assert.equal(calls, 4);

	unsubscribe();
	store.add({ message: 'Three' });
	assert.equal(calls, 4);
});

test('the snapshot is stable between changes', () => {
	const store = createToastStore();
	store.add({ message: 'One' });
	assert.equal(store.getSnapshot(), store.getSnapshot());
});
