import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
	getSessionStorageItem,
	removeSessionStorageItem,
	setSessionStorageItem,
} from './sessionStorage';

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

afterEach(() => {
	if (originalDescriptor) {
		Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage');
	}
});

describe('safe sessionStorage helpers', () => {
	it('reads, writes, and removes values when storage works', () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => { values.set(key, value); },
			removeItem: (key: string) => { values.delete(key); },
		} as unknown as Storage;

		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			value: storage,
		});

		assert.equal(setSessionStorageItem('auth', 'token'), true);
		assert.equal(getSessionStorageItem('auth'), 'token');
		removeSessionStorageItem('auth');
		assert.equal(getSessionStorageItem('auth'), null);
	});

	it('falls back when reading the sessionStorage property itself throws', () => {
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			get() {
				throw new Error('blocked by browser policy');
			},
		});

		assert.equal(getSessionStorageItem('auth'), null);
		assert.equal(setSessionStorageItem('auth', 'token'), false);
		assert.doesNotThrow(() => removeSessionStorageItem('auth'));
	});

	it('falls back when storage methods throw', () => {
		const storage = {
			getItem: () => { throw new Error('blocked'); },
			setItem: () => { throw new Error('quota'); },
			removeItem: () => { throw new Error('blocked'); },
		} as unknown as Storage;

		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			value: storage,
		});

		assert.equal(getSessionStorageItem('auth'), null);
		assert.equal(setSessionStorageItem('auth', 'token'), false);
		assert.doesNotThrow(() => removeSessionStorageItem('auth'));
	});
});
